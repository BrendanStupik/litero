// =========================================================================
// 1. STATE & GLOBAL VARIABLES
// =========================================================================
let activeTags = [];
let currentData = null;
let groupByBook = false;
let booksOnly = false;
let currentAppMode = "browse";

let hoveredCardId = null;
let hoveredCardCtx = null;

let currentSrsHighlightId = null;
let sessionReviewCount = 0;
let srsActiveTags = [];
let srsFetchTimeout = null;
let sessionSkippedIds = [];

let graphData = null;
let graphSimulation = null;
let currentGraphFilter = 'all';

let libraryData = null;
let libraryActiveCategory = 'all';
let currentBookView = null;
let libraryActiveTags = [];
let librarySortBy = 'last_highlighted';
let currentBrowseSort = 'alpha';
let currentBookSort = 'count';
let currentBookData = null;
let bookActiveTags = [];

// Tag Menu & Context State
let lastViewedTag = null;
let activeTagActionCallback = null;
let activeTagForMenu = null;
let clipboardTags = [];
let contextTargetId = null;
let contextTargetCtx = null;
let contextTargetTag = null;

// Search Modals
const searchOverlay = document.getElementById('search-overlay');
const searchInput = document.getElementById('global-search-input');
const searchResultsArea = document.getElementById('search-results-area');
let searchDebounceTimeout = null;
let searchResultHighlights = new Map();

// Tag Index & Time Metrics
let absoluteMinMs = 0;
let absoluteMaxMs = 0;
let currentTagIndexData = [];
let currentTagIndexSort = 'count';
let timeMetricsTimeout = null;

const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000;
let backgroundSyncStarted = false;
let lastIncrementalSyncAt = 0;
let incrementalSyncPromise = null;
let personPageLoadToken = 0;

document.documentElement.setAttribute('data-theme', 'light');
marked.use({ breaks: true });

const APP_SANITIZE_CONFIG = {
    USE_PROFILES: { html: true, svg: true },
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'meta', 'link', 'base', 'form'],
};

const MARKDOWN_SANITIZE_CONFIG = {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'code', 'pre', 'a', 'del', 'hr', 'mark'],
    ALLOWED_ATTR: ['href', 'title', 'class'],
    ALLOW_DATA_ATTR: false,
};

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeAppHTML(html) {
    return DOMPurify.sanitize(String(html ?? ''), APP_SANITIZE_CONFIG);
}

function setSafeHTML(element, html) {
    if (element) element.innerHTML = sanitizeAppHTML(html);
}

function insertSafeHTML(element, position, html) {
    if (element) element.insertAdjacentHTML(position, sanitizeAppHTML(html));
}

function renderMarkdown(value) {
    const parsed = marked.parse(String(value ?? ''));
    return DOMPurify.sanitize(parsed, MARKDOWN_SANITIZE_CONFIG);
}

function safeURL(value, { sameOriginOnly = false, allowedHost = null, externalOnly = false } = {}) {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) return '';

    try {
        const url = new URL(rawValue, window.location.origin);
        if (sameOriginOnly && url.origin !== window.location.origin) return '';
        if (externalOnly && url.origin === window.location.origin) return '';
        if (url.origin !== window.location.origin && url.protocol !== 'https:') return '';
        if (allowedHost && url.hostname !== allowedHost) return '';
        return url.href;
    } catch {
        return '';
    }
}

function setDatalistOptions(element, values) {
    if (!element) return;
    element.replaceChildren();
    for (const value of values || []) {
        const option = document.createElement('option');
        option.value = String(value || '');
        element.appendChild(option);
    }
}

function clearElement(element) {
    if (element) element.replaceChildren();
}

function renderLinkedPlainText(element, text, tags, excludedTag = '') {
    if (!element) return;
    element.replaceChildren();
    const candidates = (tags || [])
        .map(String)
        .filter(tag => tag.length >= 3 && tag.toLowerCase() !== String(excludedTag).toLowerCase())
        .sort((a, b) => b.length - a.length);
    if (candidates.length === 0) {
        element.textContent = String(text || '');
        return;
    }
    const escaped = candidates.map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const matcher = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
    const canonical = new Map(candidates.map(tag => [tag.toLowerCase(), tag]));
    let cursor = 0;
    const source = String(text || '');
    for (const match of source.matchAll(matcher)) {
        if (match.index > cursor) element.appendChild(document.createTextNode(source.slice(cursor, match.index)));
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'person-tag-link';
        link.dataset.tagMenu = canonical.get(match[0].toLowerCase()) || match[0];
        link.textContent = match[0];
        element.appendChild(link);
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length) element.appendChild(document.createTextNode(source.slice(cursor)));
}

function jsonPost(url, payload = {}) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

// =========================================================================
// 2. INITIALIZATION & GLOBAL LISTENERS
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    void fetchExplorationData();
    void fetchLibraryExplorationData();
    void fetchTimeMetrics(null, null, true);
    startBackgroundHighlightSync();
});

document.addEventListener('click', (e) => {
    if (e.target.id === 'search-overlay') closeSearch(e);
    if (e.target.id === 'taxonomy-overlay') closeTaxonomyConfig(e);

    const viewEl = e.target.closest('[data-view]');
    if (viewEl) {
        if (viewEl.dataset.view === 'tags') openTagsTab();
        else switchView(viewEl.dataset.view);
        if (viewEl.dataset.mobileNav === 'true') updateMobileNav(viewEl);
    }

    const externalEl = e.target.closest('[data-external-url]');
    if (externalEl) {
        const url = safeURL(externalEl.dataset.externalUrl, { allowedHost: 'readwise.io' });
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
        const actions = {
            'copy-single-tag': copySingleTagFromContext,
            'copy-tags': copyTagsFromContext,
            'paste-tags': pasteTagsToContext,
            'set-page': promptSetPageFromContext,
            'tag-filter': executeTagFilter,
            'tag-page': executeTagPage,
            'close-taxonomy': closeTaxonomyConfig,
            'save-taxonomy': saveTaxonomyConfig,
            'open-tags': openTagsTab,
            'open-taxonomy': openTaxonomyConfig,
            'run-taxonomy': triggerTaxonomer,
            'incremental-sync': triggerIncrementalSync,
            'open-search': openSearch,
            'toggle-mobile-sidebar': toggleMobileSidebar,
            'close-book': closeBookView,
            'manual-sync': triggerManualSync,
            'skip-srs': skipSRSCard,
            'back-to-tags': openTagsTab,
            'toggle-person-blurb': togglePersonBlurb,
        };
        const handler = actions[actionEl.dataset.action];
        if (handler) handler();
    }

    const browseSortEl = e.target.closest('[data-browse-sort]');
    if (browseSortEl) changeBrowseSort(browseSortEl.dataset.browseSort);
    const bookSortEl = e.target.closest('[data-book-sort]');
    if (bookSortEl) changeBookSort(bookSortEl.dataset.bookSort);
    const tagSortEl = e.target.closest('[data-tag-index-sort]');
    if (tagSortEl) sortTagIndex(tagSortEl.dataset.tagIndexSort);

    const openBookEl = e.target.closest('[data-open-book]');
    if (openBookEl) openBookView(openBookEl.dataset.openBook);
    const openPersonEl = e.target.closest('[data-open-person]');
    if (openPersonEl) openPersonPage(openPersonEl.dataset.openPerson);
    const toggleGroupEl = e.target.closest('[data-toggle-book-group]');
    if (toggleGroupEl) toggleBookGroup(toggleGroupEl.dataset.toggleBookGroup);
    const toggleBookTagEl = e.target.closest('[data-toggle-book-tag]');
    if (toggleBookTagEl) toggleBookTag(toggleBookTagEl.dataset.toggleBookTag);
    const removeSrsTagEl = e.target.closest('[data-remove-srs-tag]');
    if (removeSrsTagEl) removeSrsTag(removeSrsTagEl.dataset.removeSrsTag);
    const ratingEl = e.target.closest('[data-srs-rating]');
    if (ratingEl) submitSRSRating(Number(ratingEl.dataset.srsRating));

    const tagMenuEl = e.target.closest('[data-tag-menu]');
    if (tagMenuEl) {
        const tag = tagMenuEl.dataset.tagMenu;
        showTagClickMenu(e, tag, () => selectSearchTag(tag));
        return;
    }
    const deleteTagEl = e.target.closest('[data-delete-tag]');
    if (deleteTagEl) deleteTag(deleteTagEl.dataset.highlightId, deleteTagEl.dataset.deleteTag, deleteTagEl.dataset.ctx);

    const cardActionEl = e.target.closest('[data-card-action]');
    if (cardActionEl) {
        const id = cardActionEl.dataset.highlightId;
        const ctx = cardActionEl.dataset.ctx;
        const handlers = {
            'edit-text': enableTextEdit,
            'delete-highlight': deleteHighlight,
            'save-text': saveText,
            'cancel-text': cancelTextEdit,
            'edit-note': enableEdit,
            'save-note': saveNote,
            'cancel-note': cancelEdit,
            'add-tag': showTagInput,
        };
        const handler = handlers[cardActionEl.dataset.cardAction];
        if (handler) handler(id, ctx);
    }

    const focusEl = e.target.closest('[data-focus-highlight]');
    if (focusEl) {
        const highlight = searchResultHighlights.get(focusEl.dataset.focusHighlight);
        if (highlight) focusSingleHighlight(highlight);
    }

    if (!e.target.closest('#custom-context-menu')) {
        const cm = document.getElementById('custom-context-menu');
        if (cm) cm.style.display = 'none';
    }
    if (!e.target.closest('#tag-click-menu')) {
        const tm = document.getElementById('tag-click-menu');
        if (tm) tm.style.display = 'none';
    }
});

document.addEventListener('change', (e) => {
    const action = e.target.dataset.changeAction;
    if (action === 'toggle-grouping') toggleGrouping(e.target.checked);
    if (action === 'toggle-books-only') toggleBooksOnly(e.target.checked);
    if (action === 'library-sort') {
        librarySortBy = e.target.value;
        fetchLibraryExplorationData();
    }
    if (action === 'srs-refresh') fetchNextSRS();
    if (action === 'map-filter') updateMapFilter();
    if (action === 'library-category') {
        libraryActiveCategory = e.target.value;
        renderLibraryDashboard();
    }
});

document.addEventListener('input', (e) => {
    const action = e.target.dataset.inputAction;
    if (action === 'library-search') renderLibraryDashboard();
    if (action === 'srs-book') debounceSRSFetch();
});

document.addEventListener('contextmenu', (e) => {
    const tagEl = e.target.closest('.card-tag-text, .tag-pill');
    if (tagEl) {
        e.preventDefault();
        e.stopPropagation();
        contextTargetTag = tagEl.textContent.replace(/^#/, '').trim();
        const menu = document.getElementById('custom-context-menu');

        document.getElementById('menu-copy-tags').style.display = 'none';
        document.getElementById('menu-paste-tags').style.display = 'none';
        document.getElementById('menu-set-page').style.display = 'none';
        document.getElementById('menu-copy-single-tag').style.display = 'flex';

        menu.style.display = 'block';
        let x = e.clientX; let y = e.clientY;
        if (x + menu.offsetWidth > window.innerWidth) x -= menu.offsetWidth;
        if (y + menu.offsetHeight > window.innerHeight) y -= menu.offsetHeight;
        menu.style.left = `${x}px`; menu.style.top = `${y}px`;
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        openSearch();
        return;
    }
    if (e.key === 'Escape' && searchOverlay.style.display === 'flex') {
        closeSearch();
        return;
    }
    if (e.target.matches('input, textarea')) return;

    if (e.key === 't' && hoveredCardId && hoveredCardCtx) {
        e.preventDefault();
        showTagInput(hoveredCardId, hoveredCardCtx);
    }
    if (currentAppMode === "study" && currentSrsHighlightId) {
        const num = parseInt(e.key);
        if (num >= 0 && num <= 5) submitSRSRating(num);
        if (e.key.toLowerCase() === 's') skipSRSCard();
    }
});

// =========================================================================
// 3. NAVIGATION & VIEW MANAGEMENT
// =========================================================================
function switchView(viewName) {
    currentAppMode = viewName;
    ['browse', 'books', 'study', 'map', 'search', 'person', 'tags'].forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.style.display = viewName === v ? 'grid' : 'none';
        const nav = document.getElementById(`nav-${v}`);
        if (nav) nav.className = `nav-item ${viewName === v ? 'active' : ''}`;
    });

    if (viewName === 'study' && !currentSrsHighlightId) fetchNextSRS();
    if (viewName === 'browse' && !currentData) fetchExplorationData();
    if (viewName === 'books' && !libraryData) fetchLibraryExplorationData();
    if (viewName === 'map' && !graphData) initMap();
}

function updateMobileNav(clickedEl) {
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => btn.classList.remove('active'));
    clickedEl.classList.add('active');
    document.querySelectorAll('.sidebar.mobile-open').forEach(sb => closeMobileSidebar(sb));
}

function toggleMobileSidebar() {
    const activeView = document.querySelector(`.view-container[id="view-${currentAppMode}"]`);
    if (!activeView) return;

    const sidebar = activeView.querySelector('.sidebar');
    if (!sidebar) return;

    const filterBtn = document.getElementById('mobile-filter-btn');

    if (sidebar.classList.contains('mobile-open')) {
        closeMobileSidebar(sidebar);
    } else {
        sidebar.classList.add('mobile-open');
        if (filterBtn) filterBtn.style.color = 'var(--accent)';
        initMobileDragHandler(sidebar);
    }
}

function closeMobileSidebar(sidebar) {
    sidebar.classList.remove('mobile-open');
    sidebar.style.transform = '';
    const filterBtn = document.getElementById('mobile-filter-btn');
    if (filterBtn) filterBtn.style.color = '';
}

function initMobileDragHandler(sidebar) {
    if (sidebar.dataset.dragInitialized === "true") return;
    sidebar.dataset.dragInitialized = "true";

    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    sidebar.addEventListener('touchstart', (e) => {
        const target = e.target;
        if (target.closest('.scrollable-tags') || target.closest('.apple-list')) return;
        startY = e.touches[0].clientY;
        isDragging = true;
        sidebar.style.transition = 'none';
    }, { passive: true });

    sidebar.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;
        if (deltaY > 0) sidebar.style.transform = `translateY(${deltaY}px)`;
    }, { passive: true });

    sidebar.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        isDragging = false;
        sidebar.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
        const deltaY = currentY - startY;
        if (deltaY > 120) {
            closeMobileSidebar(sidebar);
        } else {
            sidebar.style.transform = 'translateY(0)';
        }
    });
}

function parseHistoricalDate(dateStr) {
    if (!dateStr) return null;
    let clean = dateStr.toLowerCase().replace(/circa|c\.|fl\.|~|approx/g, '').replace(/[(),]/g, '').trim();
    const centuryMatch = clean.match(/(\d+)(?:st|nd|rd|th)\s+century\s*(bc|bce|ad|ce)?/);

    if (centuryMatch) {
        let cent = parseInt(centuryMatch[1]) * 100;
        let isBC = centuryMatch[2] && centuryMatch[2].startsWith('bc');
        let year = isBC ? -(cent - 50) : (cent - 50);
        return { start: year - 50, end: year + 50, isRange: true };
    }

    let parts = clean.split(/\s*[- ]\s*/);
    if (parts.length === 1) {
        let isBC = clean.includes('bc') || clean.includes('bce');
        let match = clean.match(/\d+/);
        if (!match) return null;
        let year = parseInt(match[0]);
        if (isBC) year = -year;
        return { start: year, end: year, isRange: false };
    }

    let startStr = parts[0]; let endStr = parts[1];
    let endBC = endStr.includes('bc') || endStr.includes('bce');
    let startBC = startStr.includes('bc') || startStr.includes('bce') || (endBC && !startStr.includes('ad'));
    let startMatch = startStr.match(/\d+/); let endMatch = endStr.match(/\d+/);

    if (!startMatch || !endMatch) return null;

    let startYear = parseInt(startMatch[0]); let endYear = parseInt(endMatch[0]);
    if (startBC) startYear = -startYear;
    if (endBC) endYear = -endYear;
    return { start: startYear, end: endYear, isRange: startYear !== endYear };
}

// =========================================================================
// 4. SHARED UI HELPERS (TAXONOMY & CARDS)
// =========================================================================
function renderTaxonomySidebar(targetContainer, sourceData, activeTagsArray, toggleFunc, sortMethod, emptyMessage) {
    targetContainer.innerHTML = '';
    if (!sourceData || !sourceData.related_tags_grouped) return;

    const categories = Object.keys(sourceData.related_tags_grouped).sort((a, b) => {
        if (a === 'Person') return -1;
        if (b === 'Person') return 1;
        return a.localeCompare(b);
    });

    let hasAnyTags = false;

    categories.forEach(category => {
        const tagsData = sourceData.related_tags_grouped[category];
        let hasItems = Array.isArray(tagsData) ? tagsData.length > 0 : (typeof tagsData === 'object' && tagsData !== null ? Object.keys(tagsData).length > 0 : false);

        if (hasItems) {
            hasAnyTags = true;
            const groupTitle = document.createElement('h3');
            groupTitle.textContent = category === 'Person' ? 'People Referenced' : category;
            targetContainer.appendChild(groupTitle);

            if (Array.isArray(tagsData)) {
                renderTagList(tagsData, targetContainer, activeTagsArray, toggleFunc, sourceData, sortMethod);
            } else {
                for (const [parentField, childTags] of Object.entries(tagsData).sort((a, b) => a[0].localeCompare(b[0]))) {
                    const fieldContainer = document.createElement('div');
                    fieldContainer.className = 'taxonomy-field-container';

                    const fieldLabel = document.createElement('div');
                    fieldLabel.textContent = parentField;
                    fieldLabel.className = 'taxonomy-field-label';

                    fieldContainer.appendChild(fieldLabel);
                    renderTagList(childTags, fieldContainer, activeTagsArray, toggleFunc, sourceData, sortMethod);
                    targetContainer.appendChild(fieldContainer);
                }
            }
        }
    });

    if (!hasAnyTags) {
        setSafeHTML(targetContainer, `<p class="empty-state-text">${escapeHTML(emptyMessage)}</p>`);
    }
}

function renderTagList(tagsData, container, activeArray, toggleFunc, data, sortMethod) {
    const tagCounts = data.tag_counts || {};
    const countsArray = Object.values(tagCounts);
    const maxCount = countsArray.length > 0 ? Math.max(...countsArray) : 1;

    const tagsArray = tagsData.map(tag => {
        const count = Number(tagCounts[tag]) || 1;
        const dateStr = data.tag_dates ? String(data.tag_dates[tag] || '') : '';
        return { tag: String(tag), count, dateStr, parsedDate: parseHistoricalDate(dateStr) };
    });

    if (sortMethod === 'count') {
        tagsArray.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    } else if (sortMethod === 'time') {
        tagsArray.sort((a, b) => {
            if (a.parsedDate && b.parsedDate) return a.parsedDate.start - b.parsedDate.start;
            if (a.parsedDate) return -1;
            if (b.parsedDate) return 1;
            return a.tag.localeCompare(b.tag);
        });
    } else {
        tagsArray.sort((a, b) => a.tag.localeCompare(b.tag));
    }

    const listContainer = document.createElement('ul');
    listContainer.className = 'apple-list';

    for (const item of tagsArray) {
        const li = document.createElement('li');
        li.className = 'apple-list-item';
        if (activeArray.includes(item.tag)) li.classList.add('active');

        const info = document.createElement('div');
        info.className = 'tag-item-info';
        const name = document.createElement('span');
        name.textContent = item.tag;
        info.appendChild(name);
        if (sortMethod === 'time' && item.dateStr) {
            const subtitle = document.createElement('span');
            subtitle.className = 'tag-subtitle';
            subtitle.textContent = item.dateStr;
            info.appendChild(subtitle);
        }

        let level = 1;
        if (item.count > 1) {
            const ratio = item.count / maxCount;
            level = ratio > 0.5 ? 4 : ratio > 0.15 ? 3 : 2;
        }
        const frequency = document.createElement('div');
        frequency.className = 'freq-container';
        frequency.title = `${item.count} occurrences`;
        for (let i = 1; i <= 4; i += 1) {
            const bar = document.createElement('div');
            bar.className = 'freq-bar';
            bar.style.height = `${6 + (i * 3)}px`;
            bar.style.background = i <= level ? 'var(--accent)' : 'var(--text-dim)';
            bar.style.opacity = i <= level ? '1' : '0.2';
            frequency.appendChild(bar);
        }

        li.append(info, frequency);
        li.addEventListener('click', event => showTagClickMenu(event, item.tag, () => toggleFunc(item.tag)));
        listContainer.appendChild(li);
    }

    container.appendChild(listContainer);
}

function sortHighlightsByLocation(hls) {
    return hls.sort((a, b) => {
        const locA = parseInt(a.location) || 0;
        const locB = parseInt(b.location) || 0;
        return locA - locB;
    });
}

function createHighlightCard(hl, showTitle, ctx = 'browse', highlightQuery = null) {
    const card = document.createElement('div');
    card.className = 'highlight-card';
    card.id = `card-${ctx}-${hl.highlight_id}`;
    card.dataset.userBookId = String(hl.user_book_id || '');
    card.dataset.location = String(hl.location || '');
    card.dataset.locationType = String(hl.location_type || '');

    card.onmouseenter = () => { hoveredCardId = hl.highlight_id; hoveredCardCtx = ctx; };
    card.onmouseleave = () => { hoveredCardId = null; hoveredCardCtx = null; };
    card.oncontextmenu = (e) => handleContextMenu(e, hl.highlight_id, ctx);

    const id = escapeHTML(hl.highlight_id);
    const safeCtx = escapeHTML(ctx);
    const title = escapeHTML(hl.book_title || 'Unknown');
    const author = escapeHTML(hl.book_author || 'Unknown');
    const readwiseURL = safeURL(hl.readwise_url, { allowedHost: 'readwise.io' });

    const titleLink = `<a href="#" data-open-book="${title}" title="${title}">${title} by ${author}</a>`;
    const externalLink = readwiseURL
        ? `<a href="${escapeHTML(readwiseURL)}" target="_blank" rel="noopener noreferrer" title="Open in Readwise" style="text-decoration: none;"></a>`
        : '';

    const actionButtons = `
        <div class="card-actions">
            <button class="action-dot edit" title="Edit Text" id="text-edit-btn-${safeCtx}-${id}" data-card-action="edit-text" data-highlight-id="${id}" data-ctx="${safeCtx}"></button>
            <button class="action-dot delete" title="Delete Highlight" data-card-action="delete-highlight" data-highlight-id="${id}" data-ctx="${safeCtx}"></button>
        </div>
    `;

    const titleHtml = showTitle ? `
        <div class="source-title">
            <div class="source-title-link">${titleLink}</div>
            ${externalLink ? `<div class="source-title-ext">${externalLink}</div>` : ''}
            ${actionButtons}
        </div>
    ` : `<div class="source-title" style="margin-bottom: 0; justify-content: flex-end;">${actionButtons}</div>`;

    let rawText = String(hl.text || '');
    rawText = rawText.replace(/^([A-Za-z0-9][A-Za-z0-9\s\-]{0,40}):/gm, '**$1**:');
    let parsedText = marked.parse(rawText);
    let parsedNote = hl.note ? marked.parse(String(hl.note)) : `<span class="empty-note-text">No note attached.</span>`;

    if (highlightQuery) {
        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const criteria = highlightQuery.split(',').map(value => value.trim()).filter(value => value && !value.startsWith('#'));
        const termsToHighlight = criteria.map(value => {
            if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1);
            return value;
        }).filter(value => value.length > 0);

        if (termsToHighlight.length > 0) {
            const regexStr = termsToHighlight.map(escapeRegExp).join('|');
            const regex = new RegExp(`(${regexStr})(?![^<]*>)`, 'gi');
            parsedText = parsedText.replace(regex, '<mark class="search-highlight">$1</mark>');
            if (hl.note) parsedNote = parsedNote.replace(regex, '<mark class="search-highlight">$1</mark>');
        }
    }

    parsedText = DOMPurify.sanitize(parsedText, MARKDOWN_SANITIZE_CONFIG);
    parsedNote = DOMPurify.sanitize(parsedNote, MARKDOWN_SANITIZE_CONFIG);

    const textSection = `
        <div class="text-section-wrapper">
            <div class="text-content" id="text-display-${safeCtx}-${id}">${parsedText}</div>
            <div id="text-editor-${safeCtx}-${id}" class="highlight-editor" style="display: none;">
                <textarea class="note-textarea" id="text-input-${safeCtx}-${id}">${escapeHTML(hl.text || '')}</textarea>
                <button class="save-btn" data-card-action="save-text" data-highlight-id="${id}" data-ctx="${safeCtx}">Save Text</button>
                <button class="cancel-btn" data-card-action="cancel-text" data-highlight-id="${id}" data-ctx="${safeCtx}">Cancel</button>
            </div>
        </div>
    `;

    const pageBadge = (hl.location_type === 'page' && hl.location)
        ? `<div class="page-badge">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>
             Page ${escapeHTML(hl.location)}
           </div>`
        : '';

    const mainContent = `
        ${titleHtml}${textSection}${pageBadge}
        <div class="note-container" id="note-container-${safeCtx}-${id}">
            <button class="note-edit-btn" title="Edit Note" data-card-action="edit-note" data-highlight-id="${id}" data-ctx="${safeCtx}"></button>
            <strong>Note:</strong>
            <div class="note-content" id="note-text-${safeCtx}-${id}">${parsedNote}</div>
            <div id="note-editor-${safeCtx}-${id}" style="display: none;">
                <textarea class="note-textarea" id="note-input-${safeCtx}-${id}">${escapeHTML(hl.note || '')}</textarea>
                <button class="save-btn" data-card-action="save-note" data-highlight-id="${id}" data-ctx="${safeCtx}">Save</button>
                <button class="cancel-btn" data-card-action="cancel-note" data-highlight-id="${id}" data-ctx="${safeCtx}">Cancel</button>
            </div>
        </div>
        <div class="card-tags" id="tags-container-${safeCtx}-${id}"></div>
    `;

    const coverURL = safeURL(hl.cover_url, { sameOriginOnly: true });
    const validCoverURL = coverURL && new URL(coverURL).pathname.startsWith('/api/covers/') ? coverURL : '';
    if (validCoverURL && showTitle) {
        setSafeHTML(card, `<div class="card-layout-wrapper"><div class="card-cover-column"><img src="${escapeHTML(validCoverURL)}" class="card-cover-img" alt=""></div><div class="card-content-column">${mainContent}</div></div>`);
    } else {
        setSafeHTML(card, mainContent);
    }

    renderCardTagsHTML(card.querySelector('.card-tags'), hl, ctx);
    return card;
}

function renderCardTagsHTML(container, hl, ctx) {
    const id = escapeHTML(hl.highlight_id);
    const safeCtx = escapeHTML(ctx);
    const tagPills = (hl.tags || []).map(tag => {
        const safeTag = escapeHTML(tag);
        return `<span class="card-tag-pill"><span class="card-tag-text" data-tag-menu="${safeTag}">#${safeTag}</span> <span class="remove-tag-btn" data-delete-tag="${safeTag}" data-highlight-id="${id}" data-ctx="${safeCtx}" title="Remove tag">&times;</span></span>`;
    }).join('');

    setSafeHTML(container, `
        ${tagPills}
        <button class="add-tag-btn" id="add-btn-${safeCtx}-${id}" data-card-action="add-tag" data-highlight-id="${id}" data-ctx="${safeCtx}">+ Add Tag</button>
        <div class="tag-input-container" id="tag-input-wrapper-${safeCtx}-${id}">
            <input type="text" id="tag-input-field-${safeCtx}-${id}" class="tag-input-field" list="all-tags-datalist" placeholder="Add tag..." maxlength="200">
            <span class="tag-input-help">Enter to save, Esc to cancel</span>
        </div>
    `);

    const inputField = container.querySelector('.tag-input-field');
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitNewTag(hl.highlight_id, inputField.value, ctx);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideTagInput(hl.highlight_id, ctx);
        }
    });
}

function getHighlightFromContext(id, ctx) {
    const container = document.getElementById(`tags-container-${ctx}-${id}`);
    if (!container) return { highlight_id: id, tags: [] };
    let tags = Array.from(container.querySelectorAll('.card-tag-text')).map(span =>
        span.textContent.replace(/^#/, '').trim()
    );
    return { highlight_id: id, tags: tags };
}

function showTagInput(id, ctx) {
    document.getElementById(`add-btn-${ctx}-${id}`).style.display = 'none';
    document.getElementById(`tag-input-wrapper-${ctx}-${id}`).style.display = 'flex';
    const input = document.getElementById(`tag-input-field-${ctx}-${id}`);
    input.value = '';
    input.focus();
}

function hideTagInput(id, ctx) {
    document.getElementById(`tag-input-wrapper-${ctx}-${id}`).style.display = 'none';
    document.getElementById(`add-btn-${ctx}-${id}`).style.display = 'inline-block';
    document.body.focus();
}

function enableEdit(id, ctx) {
    document.getElementById(`note-text-${ctx}-${id}`).style.display = 'none';
    document.querySelector(`#note-container-${ctx}-${id} .note-edit-btn`).style.display = 'none';
    document.getElementById(`note-editor-${ctx}-${id}`).style.display = 'block';
}

function cancelEdit(id, ctx) {
    document.getElementById(`note-text-${ctx}-${id}`).style.display = 'block';
    document.querySelector(`#note-container-${ctx}-${id} .note-edit-btn`).style.display = 'block';
    document.getElementById(`note-editor-${ctx}-${id}`).style.display = 'none';
}

function enableTextEdit(id, ctx) {
    document.getElementById(`text-display-${ctx}-${id}`).style.display = 'none';
    document.getElementById(`text-editor-${ctx}-${id}`).style.display = 'block';
}

function cancelTextEdit(id, ctx) {
    document.getElementById(`text-display-${ctx}-${id}`).style.display = 'block';
    document.getElementById(`text-editor-${ctx}-${id}`).style.display = 'none';
}

async function submitNewTag(id, tagName, ctx) {
    tagName = tagName.trim();
    if (!tagName) return hideTagInput(id, ctx);

    const hl = getHighlightFromContext(id, ctx);
    if (hl.tags.includes(tagName)) return hideTagInput(id, ctx);

    hl.tags.push(tagName);
    renderCardTagsHTML(document.getElementById(`tags-container-${ctx}-${id}`), hl, ctx);

    try {
        const resp = await fetch('/api/add_tag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: id, tag_name: tagName })
        });
        if (!(await resp.json()).success) throw new Error();

        if (currentData) {
            const dataHl = currentData.highlights.find(h => h.highlight_id == id);
            if (dataHl && !dataHl.tags.includes(tagName)) dataHl.tags.push(tagName);
        }
    } catch (e) {
        hl.tags = hl.tags.filter(t => t !== tagName);
        renderCardTagsHTML(document.getElementById(`tags-container-${ctx}-${id}`), hl, ctx);
        alert("Failed to sync tag.");
    }
}

async function deleteTag(id, tagName, ctx) {
    const hl = getHighlightFromContext(id, ctx);
    hl.tags = hl.tags.filter(t => t !== tagName);
    renderCardTagsHTML(document.getElementById(`tags-container-${ctx}-${id}`), hl, ctx);

    try {
        const resp = await fetch('/api/remove_tag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: id, tag_name: tagName })
        });
        if (!(await resp.json()).success) throw new Error();

        if (currentData) {
            const dataHl = currentData.highlights.find(h => h.highlight_id == id);
            if (dataHl) dataHl.tags = dataHl.tags.filter(t => t !== tagName);
        }
    } catch (e) {
        hl.tags.push(tagName);
        renderCardTagsHTML(document.getElementById(`tags-container-${ctx}-${id}`), hl, ctx);
        alert("Failed to delete tag.");
    }
}

async function deleteHighlight(id, ctx) {
    if (!confirm("Are you sure you want to permanently delete this highlight? This action cannot be undone.")) return;
    const card = document.getElementById(`card-${ctx}-${id}`);
    if(card) card.style.opacity = '0.5';

    try {
        const resp = await fetch('/api/delete_highlight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: id })
        });
        const data = await resp.json();

        if (data.success) {
            if (card) {
                card.style.transform = 'scale(0.9)';
                setTimeout(() => card.remove(), 200);
            }
            if (currentData) currentData.highlights = currentData.highlights.filter(h => h.highlight_id != id);
            if (currentBookData) currentBookData.highlights = currentBookData.highlights.filter(h => h.highlight_id != id);
        } else {
            alert("Failed to delete highlight: " + (data.error || "Unknown error"));
            if(card) card.style.opacity = '1';
        }
    } catch (e) {
        alert("Network error.");
        if(card) card.style.opacity = '1';
    }
}

async function saveNote(id, ctx) {
    const newNote = document.getElementById(`note-input-${ctx}-${id}`).value;
    const saveBtn = document.querySelector(`#note-editor-${ctx}-${id} .save-btn`);
    saveBtn.textContent = "Saving...";
    saveBtn.disabled = true;

    try {
        const response = await fetch('/api/update_note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: id, note: newNote })
        });
        if ((await response.json()).success) {
            if (currentData) {
                const dataHl = currentData.highlights.find(h => h.highlight_id == id);
                if (dataHl) dataHl.note = newNote;
            }
            setSafeHTML(document.getElementById(`note-text-${ctx}-${id}`), newNote ? renderMarkdown(newNote) : `<span class="empty-note-text">No note attached.</span>`);
            cancelEdit(id, ctx);
        } else {
            alert("Failed to save note.");
        }
    } catch (e) {
        alert("Network error.");
    } finally {
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
    }
}

async function saveText(id, ctx) {
    const newText = document.getElementById(`text-input-${ctx}-${id}`).value;
    const saveBtn = document.querySelector(`#text-editor-${ctx}-${id} .save-btn`);
    saveBtn.textContent = "Saving...";
    saveBtn.disabled = true;

    try {
        const response = await fetch('/api/update_highlight_text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: id, text: newText })
        });
        if ((await response.json()).success) {
            if (currentData) {
                const dataHl = currentData.highlights.find(h => h.highlight_id == id);
                if (dataHl) dataHl.text = newText;
            }
            setSafeHTML(document.getElementById(`text-display-${ctx}-${id}`), renderMarkdown(newText));
            cancelTextEdit(id, ctx);
        } else {
            alert("Failed to save text.");
        }
    } catch (e) {
        alert("Network error.");
    } finally {
        saveBtn.textContent = "Save Text";
        saveBtn.disabled = false;
    }
}

// =========================================================================
// 5. DATABASE SYNCING LOGIC
// =========================================================================
function getCurrentTagIndexRange() {
    if (!absoluteMinMs || !absoluteMaxMs) return { startDate: null, endDate: null };

    const startDate = document.getElementById('slider-display-start')?.textContent || null;
    const endDate = document.getElementById('slider-display-end')?.textContent || null;
    return {
        startDate: startDate === msToDateStr(absoluteMinMs) ? null : startDate,
        endDate: endDate === msToDateStr(absoluteMaxMs) ? null : endDate,
    };
}

async function refreshClientDataAfterSync() {
    const { startDate, endDate } = getCurrentTagIndexRange();
    await Promise.allSettled([
        fetchExplorationData(),
        fetchLibraryExplorationData(),
        fetchTimeMetrics(startDate, endDate, true),
    ]);

    if (currentAppMode === 'books' && currentBookView) {
        await openBookView(currentBookView);
    } else if (currentAppMode === 'person' && lastViewedTag) {
        await openPersonPage(lastViewedTag);
    } else if (currentAppMode === 'study' && !currentSrsHighlightId) {
        await fetchNextSRS();
    } else if (currentAppMode === 'map') {
        graphData = null;
        await initMap();
    }
}

async function triggerIncrementalSync(silent = false) {
    if (incrementalSyncPromise) return incrementalSyncPromise;

    incrementalSyncPromise = (async () => {
        const icon = document.getElementById('sync-icon');
        if (!silent && icon) icon.style.transform = "rotate(360deg)";

        try {
            const resp = await jsonPost('/api/sync/incremental');
            const data = await resp.json();
            lastIncrementalSyncAt = Date.now();

            if (data.success && data.new_count > 0) {
                await refreshClientDataAfterSync();
                if (!silent && icon) {
                    const originalColor = icon.style.fill;
                    icon.style.fill = "var(--success)";
                    setTimeout(() => icon.style.fill = originalColor, 2000);
                }
            } else if (!data.success && !silent) {
                alert("Incremental sync failed: " + data.error);
            }
            return data;
        } catch (e) {
            if (!silent) alert("Network error during sync.");
            console.error("Incremental sync failed", e);
            return { success: false, error: String(e) };
        } finally {
            if (!silent && icon) {
                setTimeout(() => icon.style.transform = "rotate(0deg)", 1000);
            }
        }
    })();

    try {
        return await incrementalSyncPromise;
    } finally {
        incrementalSyncPromise = null;
    }
}

function startBackgroundHighlightSync() {
    if (backgroundSyncStarted) return;
    backgroundSyncStarted = true;
    lastIncrementalSyncAt = Date.now();

    window.setInterval(() => {
        void triggerIncrementalSync(true);
    }, BACKGROUND_SYNC_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
        const syncIsDue = Date.now() - lastIncrementalSyncAt >= BACKGROUND_SYNC_INTERVAL_MS;
        if (document.visibilityState === 'visible' && syncIsDue) {
            void triggerIncrementalSync(true);
        }
    });
}

async function triggerManualSync() {
    const btn = document.getElementById('manual-sync-btn');
    const originalText = btn.textContent;

    btn.textContent = "Syncing... (Takes a minute)";
    btn.disabled = true;
    btn.style.opacity = '0.5';

    try {
        const resp = await jsonPost('/api/sync');
        const data = await resp.json();

        if (data.success) {
            btn.textContent = "Sync Complete!";
            btn.style.background = "var(--success)";
            lastIncrementalSyncAt = Date.now();
            await refreshClientDataAfterSync();

            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.background = "var(--accent)";
            }, 3000);
        } else {
            alert("Sync failed: " + data.error);
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    } catch (e) {
        alert("Network error during sync.");
        btn.textContent = originalText;
        btn.disabled = false;
        btn.style.opacity = '1';
    }
}

// =========================================================================
// 6. CONTEXT MENUS & MODALS
// =========================================================================
function showTagClickMenu(e, tag, filterCallback) {
    e.preventDefault();
    e.stopPropagation();
    activeTagForMenu = tag;
    activeTagActionCallback = filterCallback;
    const menu = document.getElementById('tag-click-menu');
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483647';
    let x = e.clientX;
    let y = e.clientY;
    if (x + menu.offsetWidth > window.innerWidth) x -= menu.offsetWidth;
    if (y + menu.offsetHeight > window.innerHeight) y -= menu.offsetHeight;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

function handleContextMenu(e, id, ctx) {
    e.preventDefault();
    contextTargetId = id;
    contextTargetCtx = ctx;

    const menu = document.getElementById('custom-context-menu');
    const pasteBtn = document.getElementById('menu-paste-tags');

    if (clipboardTags.length === 0) {
        setSafeHTML(pasteBtn, `Paste Tags <span style="font-size: 0.8em; opacity: 0.5;">(0)</span>`);
        pasteBtn.classList.add('disabled');
    } else {
        setSafeHTML(pasteBtn, `Paste Tags <span style="font-size: 0.8em; background: var(--accent); color: var(--bg-body); padding: 2px 6px; border-radius: 10px;">${clipboardTags.length}</span>`);
        pasteBtn.classList.remove('disabled');
    }

    document.getElementById('menu-copy-single-tag').style.display = 'none';
    document.getElementById('menu-copy-tags').style.display = 'flex';
    document.getElementById('menu-paste-tags').style.display = 'flex';
    document.getElementById('menu-set-page').style.display = 'flex';

    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483647';
    let x = e.clientX;
    let y = e.clientY;
    if (x + menu.offsetWidth > window.innerWidth) x -= menu.offsetWidth;
    if (y + menu.offsetHeight > window.innerHeight) y -= menu.offsetHeight;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

function executeTagFilter() {
    document.getElementById('tag-click-menu').style.display = 'none';
    if (activeTagActionCallback) activeTagActionCallback();
}

function executeTagPage() {
    document.getElementById('tag-click-menu').style.display = 'none';
    document.getElementById('search-overlay').style.display = 'none';
    if (activeTagForMenu) openPersonPage(activeTagForMenu);
}

function copyTagsFromContext() {
    if (!contextTargetId || !contextTargetCtx) return;
    const hl = getHighlightFromContext(contextTargetId, contextTargetCtx);
    clipboardTags = [...hl.tags];
    const copyBtn = document.getElementById('menu-copy-tags');
    const origText = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    copyBtn.style.color = "var(--success)";
    setTimeout(() => {
        copyBtn.textContent = origText;
        copyBtn.style.color = "";
        document.getElementById('custom-context-menu').style.display = 'none';
    }, 400);
}

function copySingleTagFromContext() {
    if (!contextTargetTag) return;
    clipboardTags = [contextTargetTag];
    const copyBtn = document.getElementById('menu-copy-single-tag');
    const origText = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    copyBtn.style.color = "var(--success)";
    setTimeout(() => {
        copyBtn.textContent = origText;
        copyBtn.style.color = "";
        document.getElementById('custom-context-menu').style.display = 'none';
    }, 400);
}

async function promptSetPageFromContext() {
    document.getElementById('custom-context-menu').style.display = 'none';
    if (!contextTargetId || !contextTargetCtx) return;
    const pageStr = prompt("Enter the page number for this highlight:");
    if (!pageStr) return;
    const pageNum = parseInt(pageStr);
    if (isNaN(pageNum)) {
        alert("Please enter a valid number.");
        return;
    }

    try {
        const resp = await fetch('/api/update_location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: contextTargetId, page: pageNum })
        });
        const data = await resp.json();
        if (data.success) {
            if (currentData) {
                const dataHl = currentData.highlights.find(h => h.highlight_id == contextTargetId);
                if (dataHl) { dataHl.location = pageNum; dataHl.location_type = 'page'; }
            }
            if (currentBookData) {
                const dataHl = currentBookData.highlights.find(h => h.highlight_id == contextTargetId);
                if (dataHl) { dataHl.location = pageNum; dataHl.location_type = 'page'; }
            }
            if (currentAppMode === 'books' && currentBookView) {
                renderBookView();
            } else if (currentAppMode === 'browse') {
                renderDashboard();
            }
        } else {
            alert("Failed to update page number: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        alert("Network error.");
    }
}

async function pasteTagsToContext() {
    if (!contextTargetId || !contextTargetCtx || clipboardTags.length === 0) return;
    const targetId = contextTargetId;
    const targetCtx = contextTargetCtx;
    document.getElementById('custom-context-menu').style.display = 'none';
    for (const tag of clipboardTags) {
        await submitNewTag(targetId, tag, targetCtx);
    }
}

// =========================================================================
// 7. SEARCH ENGINE
// =========================================================================
function openSearch() {
    searchOverlay.style.display = 'flex';
    searchInput.value = '';
    searchResultsArea.innerHTML = '';
    searchInput.focus();
}

function closeSearch(e) {
    if (e && e.target !== searchOverlay) return;
    searchOverlay.style.display = 'none';
    document.body.focus();
}

searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimeout);
    const val = e.target.value.trim();
    if (val.length < 2) {
        searchResultsArea.innerHTML = '';
        return;
    }
    searchDebounceTimeout = setTimeout(() => executeSearch(val), 250);
});

searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val.length < 2) return;
        closeSearch();
        await executeFullSearch(val);
    }
});

async function executeSearch(query) {
    try {
        const resp = await jsonPost('/api/search', { query });
        const data = await resp.json();
        let html = '';
        searchResultHighlights.clear();

        if (Array.isArray(data.tags) && data.tags.length > 0) {
            html += '<div class="search-section-title">Tags</div><div class="search-tags-container">';
            html += data.tags.map(tag => {
                const safeTag = escapeHTML(tag);
                return `<div class="search-tag-result" data-tag-menu="${safeTag}">#${safeTag}</div>`;
            }).join('');
            html += '</div>';
        }

        if (Array.isArray(data.highlights) && data.highlights.length > 0) {
            html += '<div class="search-section-title" style="margin-top: 20px;">Highlights <span class="search-section-subtitle">(Press Enter for all)</span></div>';
            html += data.highlights.map(hl => {
                const key = String(hl.highlight_id);
                searchResultHighlights.set(key, hl);
                const text = String(hl.text || '').replace(/[*_~`]/g, '');
                return `<div class="search-hl-result" data-focus-highlight="${escapeHTML(key)}"><div class="search-hl-text">${escapeHTML(text)}</div><div class="search-hl-meta">${escapeHTML(hl.book_title || '')}</div></div>`;
            }).join('');
        }

        setSafeHTML(searchResultsArea, html || '<div class="empty-state-text-center">No results found.</div>');
    } catch (error) {
        console.error('Search failed', error);
        setSafeHTML(searchResultsArea, '<div class="empty-state-text-center">Search failed.</div>');
    }
}

async function executeFullSearch(query) {
    switchView('search');
    document.getElementById('search-query-display').textContent = query;
    const container = document.getElementById('search-full-results-container');
    container.innerHTML = '<p class="empty-state-text-center">Fetching full search results...</p>';

    try {
        const resp = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query, full: true })
        });
        const data = await resp.json();
        document.getElementById('search-match-count').textContent = data.highlights ? data.highlights.length : 0;

        if (!data.highlights || data.highlights.length === 0) {
            container.innerHTML = `<div class="search-empty-state"><p style="color: var(--text-dim);">No highlights found.</p></div>`;
            return;
        }

        container.innerHTML = '';
        data.highlights.forEach(hl => {
            container.appendChild(createHighlightCard(hl, true, 'search-full', query));
        });
    } catch (e) {
        container.innerHTML = `<p class="empty-state-text-center" style="color: var(--danger);">Error performing full search.</p>`;
    }
}

function selectSearchTag(tag) {
    closeSearch();
    switchView('browse');
    if (!activeTags.includes(tag)) activeTags.push(tag);
    renderActiveTags();
    fetchExplorationData();
}

function focusSingleHighlight(hl) {
    closeSearch();
    switchView('browse');
    activeTags = [];
    renderActiveTags();

    const hlContainer = document.getElementById('highlights-container');
    document.getElementById('result-count').textContent = '(1 Item Focused)';

    hlContainer.innerHTML = '';
    hlContainer.appendChild(createHighlightCard(hl, true, 'search-focus'));
    document.getElementById('available-tags-container').innerHTML = '<p class="empty-state-text">Context restricted to focused item. Clear filter to restore full context.</p>';
}

// =========================================================================
// 8. VIEW MODULE: BROWSE
// =========================================================================
function changeBrowseSort(method) {
    currentBrowseSort = method;
    ['alpha', 'count', 'time'].forEach(m => {
        const btn = document.getElementById(`sort-browse-${m}`);
        if(btn) btn.classList.toggle('active', m === method);
    });
    if (currentData) renderDashboard();
}

async function fetchExplorationData() {
    const resp = await fetch('/api/explore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: activeTags })
    });
    currentData = await resp.json();
    setDatalistOptions(document.getElementById('all-tags-datalist'), currentData.all_database_tags);

    if (currentAppMode === "browse") renderDashboard();
}

function toggleTag(tagName) {
    if (activeTags.includes(tagName)) activeTags = activeTags.filter(t => t !== tagName);
    else activeTags.push(tagName);
    renderActiveTags();
    fetchExplorationData();
}

function toggleGrouping(isChecked) {
    groupByBook = isChecked;
    if (currentData) renderDashboard();
}

function toggleBooksOnly(isChecked) {
    booksOnly = isChecked;
    if (currentData) renderDashboard();
}

function renderActiveTags() {
    const container = document.getElementById('active-tags-container');
    if (activeTags.length === 0) {
        container.innerHTML = `<p class="empty-state-text">No tags selected.</p>`;
        return;
    }

    container.innerHTML = '';
    activeTags.forEach(tag => {
        const el = document.createElement('div');
        el.className = 'tag-pill tag-active';
        el.textContent = tag + '  ';
        el.onclick = () => toggleTag(tag);
        container.appendChild(el);
    });
}

function renderDashboard() {
    if (!currentData) return;
    const data = currentData;

    renderTaxonomySidebar(
        document.getElementById('available-tags-container'),
        data,
        activeTags,
        toggleTag,
        currentBrowseSort,
        'No other co-occurring tags found.'
    );

    const hlContainer = document.getElementById('highlights-container');
    let displayedHighlights = Array.isArray(data.highlights) ? data.highlights : [];
    if (booksOnly) displayedHighlights = displayedHighlights.filter(hl => hl.category === 'books');

    document.getElementById('result-count').textContent = activeTags.length === 0
        ? `(Showing ${displayedHighlights.length} of ${Number(data.total_count) || 0})`
        : `(${displayedHighlights.length} Found)`;
    clearElement(hlContainer);

    if (!groupByBook) {
        displayedHighlights.forEach(hl => hlContainer.appendChild(createHighlightCard(hl, true, 'browse')));
        return;
    }

    const groupedBooks = new Map();
    for (const hl of displayedHighlights) {
        const title = String(hl.book_title || 'Unknown');
        const author = String(hl.book_author || 'Unknown');
        const key = `${title}\u0000${author}`;
        if (!groupedBooks.has(key)) groupedBooks.set(key, { title, author, cover: hl.cover_url, hls: [] });
        groupedBooks.get(key).hls.push(hl);
    }

    let groupNumber = 0;
    for (const group of groupedBooks.values()) {
        groupNumber += 1;
        const groupId = `book-group-${groupNumber}`;
        const wrapper = document.createElement('div');
        wrapper.className = 'book-group-wrapper group-collapsed';

        const header = document.createElement('div');
        header.className = 'book-group-header-card';
        const coverURL = safeURL(group.cover, { sameOriginOnly: true });
        const coverHtml = coverURL && new URL(coverURL).pathname.startsWith('/api/covers/')
            ? `<img src="${escapeHTML(coverURL)}" class="group-cover" loading="lazy" alt="">`
            : '<div class="group-cover-placeholder">No Cover</div>';
        setSafeHTML(header, `
            ${coverHtml}
            <div class="group-meta">
                <h3 class="group-title" data-open-book="${escapeHTML(group.title)}" title="${escapeHTML(group.title)}">${escapeHTML(group.title)}</h3>
                <p class="group-author" title="${escapeHTML(group.author)}">${escapeHTML(group.author)} &nbsp; ${group.hls.length} Highlights</p>
            </div>
            <button class="group-toggle-btn" data-toggle-book-group="${groupId}" title="Collapse/Expand" type="button">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>`);

        const content = document.createElement('div');
        content.id = groupId;
        content.style.transition = 'opacity 0.3s ease';
        content.style.display = 'none';
        content.style.opacity = '0';
        sortHighlightsByLocation(group.hls).forEach(hl => content.appendChild(createHighlightCard(hl, false, 'browse')));
        wrapper.append(header, content);
        hlContainer.appendChild(wrapper);
    }
}

window.toggleBookGroup = function(groupId) {
    const content = document.getElementById(groupId);
    const wrapper = content.parentElement;

    if (content.style.display === 'none') {
        content.style.display = 'block';
        setTimeout(() => content.style.opacity = '1', 10);
        wrapper.classList.remove('group-collapsed');
    } else {
        content.style.opacity = '0';
        setTimeout(() => content.style.display = 'none', 300);
        wrapper.classList.add('group-collapsed');
    }
};

// =========================================================================
// 9. VIEW MODULE: LIBRARY (BOOKS)
// =========================================================================
async function fetchLibraryExplorationData() {
    try {
        const resp = await fetch('/api/library/explore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: libraryActiveTags, sort_by: librarySortBy })
        });
        libraryData = await resp.json();
        setDatalistOptions(document.getElementById('library-tags-datalist'), libraryData.all_book_tags);
        renderLibraryDashboard();
    } catch (e) {
        document.getElementById('books-grid').innerHTML = `<p style="color: var(--danger);">Failed to load library catalog.</p>`;
    }
}

function toggleLibraryTag(tagName) {
    if (libraryActiveTags.includes(tagName)) libraryActiveTags = libraryActiveTags.filter(t => t !== tagName);
    else libraryActiveTags.push(tagName);
    renderLibraryActiveTags();
    fetchLibraryExplorationData();
}

function renderLibraryActiveTags() {
    const container = document.getElementById('library-active-tags-container');
    if (libraryActiveTags.length === 0) {
        container.innerHTML = `<p class="empty-state-text">No tags selected.</p>`;
        return;
    }

    container.innerHTML = '';
    libraryActiveTags.forEach(tag => {
        const el = document.createElement('div');
        el.className = 'tag-pill tag-active';
        el.textContent = tag + '  ';
        el.onclick = () => toggleLibraryTag(tag);
        container.appendChild(el);
    });
}

function renderLibraryDashboard() {
    if (!libraryData) return;

    renderTaxonomySidebar(
        document.getElementById('library-available-tags-container'),
        libraryData,
        libraryActiveTags,
        toggleLibraryTag,
        'alpha',
        'No other co-occurring tags found.'
    );

    const books = Array.isArray(libraryData.books) ? libraryData.books : [];
    const catCounts = { all: books.length };
    for (const book of books) {
        const category = String(book.category || 'unknown');
        catCounts[category] = (catCounts[category] || 0) + 1;
    }

    const catsContainer = document.getElementById('library-categories');
    setSafeHTML(catsContainer, Object.keys(catCounts).sort().map(category => `
        <label class="toggle-label" style="margin-bottom: 8px;">
            <input type="radio" name="lib-cat" value="${escapeHTML(category)}" data-change-action="library-category" ${libraryActiveCategory === category ? 'checked' : ''}>
            <span style="text-transform: capitalize;">${escapeHTML(category)}</span>
            <span style="margin-left:auto; color:var(--text-muted); font-size:0.8em;">${catCounts[category]}</span>
        </label>`).join(''));

    const searchQuery = document.getElementById('library-search').value.toLowerCase();
    let filtered = books;
    if (libraryActiveCategory !== 'all') filtered = filtered.filter(book => String(book.category || 'unknown') === libraryActiveCategory);
    if (searchQuery) filtered = filtered.filter(book => String(book.title || '').toLowerCase().includes(searchQuery) || String(book.author || '').toLowerCase().includes(searchQuery));

    document.getElementById('library-count').textContent = `(${filtered.length})`;
    const html = filtered.map(book => {
        const title = String(book.title || 'Unknown Title');
        const author = String(book.author || 'Unknown Author');
        const coverURL = safeURL(book.cover_url, { sameOriginOnly: true });
        const cover = coverURL && new URL(coverURL).pathname.startsWith('/api/covers/')
            ? `<img src="${escapeHTML(coverURL)}" class="book-cover" loading="lazy" alt="">`
            : '<div class="book-cover-placeholder">No Cover</div>';
        return `<div class="book-card" data-open-book="${escapeHTML(title)}">${cover}<div class="book-title">${escapeHTML(title)}</div><div class="book-author">${escapeHTML(author)}</div><div class="book-meta">${Number(book.highlight_count) || 0} Highlights</div></div>`;
    }).join('');
    setSafeHTML(document.getElementById('books-grid'), html);
}

async function openBookView(title) {
    if (currentAppMode !== 'books') switchView('books');

    if (currentBookView !== title) bookActiveTags = [];
    currentBookView = title;

    document.getElementById('library-grid-container').style.display = 'none';
    document.getElementById('single-book-container').style.display = 'block';
    document.getElementById('library-default-sidebar').style.display = 'none';
    document.getElementById('library-book-sidebar').style.display = 'flex';

    const header = document.getElementById('single-book-header');
    const hlContainer = document.getElementById('single-book-highlights');

    header.innerHTML = '<p>Loading book data...</p>';
    hlContainer.innerHTML = '';
    document.getElementById('book-context-tags-container').innerHTML = '<p style="color:var(--text-muted);">Loading context...</p>';

    try {
        const resp = await fetch('/api/book_highlights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title })
        });
        currentBookData = await resp.json();
        renderBookView();
    } catch (e) {
        console.error("Book View Error:", e);
        header.innerHTML = `<p style="color: var(--danger);">Failed to load highlights.</p>`;
    }
}

function renderBookView() {
    if (!currentBookData || !Array.isArray(currentBookData.highlights)) return;
    const allHls = sortHighlightsByLocation(currentBookData.highlights);
    if (allHls.length === 0) return;

    let regularHls = allHls;
    if (bookActiveTags.length > 0) {
        regularHls = regularHls.filter(hl => {
            const combinedTags = (hl.tags || []).concat(hl.book_tags || []);
            return bookActiveTags.every(tag => combinedTags.includes(tag));
        });
    }

    const book = allHls[0];
    const title = String(book.book_title || 'Unknown');
    const author = String(book.book_author || 'Unknown Author');
    const coverURL = safeURL(book.cover_url, { sameOriginOnly: true });
    const cover = coverURL && new URL(coverURL).pathname.startsWith('/api/covers/')
        ? `<img src="${escapeHTML(coverURL)}" class="book-cover" style="margin:0; height:180px; width:120px;" alt="">`
        : '<div class="book-cover-placeholder" style="margin:0; height:180px; width:120px;">No Cover</div>';
    const readwiseURL = safeURL(book.readwise_url, { allowedHost: 'readwise.io' });
    const sourceURL = safeURL(book.source_url, { externalOnly: true });
    const sourceLower = sourceURL.toLowerCase();
    const sourceAllowed = sourceURL && !sourceLower.endsWith('.pdf') && !sourceLower.endsWith('.epub');
    const links = [
        readwiseURL ? `<a href="${escapeHTML(readwiseURL)}" target="_blank" rel="noopener noreferrer" class="book-header-link" style="margin-right:15px;">Open in Readwise ↗</a>` : '',
        sourceAllowed ? `<a href="${escapeHTML(sourceURL)}" target="_blank" rel="noopener noreferrer" class="book-header-link">Open Original URL ↗</a>` : '',
    ].join('');

    const count = bookActiveTags.length > 0 ? `${regularHls.length} Matches` : `${regularHls.length} Highlights`;
    setSafeHTML(document.getElementById('single-book-header'), `
        <div style="flex-shrink:0;">${cover}</div>
        <div class="book-header-layout">
            <h2 class="book-header-title-text" title="${escapeHTML(title)}">${escapeHTML(title)}</h2>
            <div class="book-header-author-text" title="${escapeHTML(author)}">${escapeHTML(author)}</div>
            <div class="book-meta" style="align-self:flex-start;">${count}</div>
            <div class="book-header-links">${links}</div>
        </div>`);

    const container = document.getElementById('single-book-highlights');
    clearElement(container);
    regularHls.forEach(hl => container.appendChild(createHighlightCard(hl, false, 'books')));
    renderBookContextSidebar();
}

function toggleBookTag(tagName) {
    if (bookActiveTags.includes(tagName)) {
        bookActiveTags = bookActiveTags.filter(t => t !== tagName);
    } else {
        bookActiveTags.push(tagName);
    }
    renderBookView();
}

function closeBookView() {
    currentBookView = null;
    currentBookData = null;
    document.getElementById('single-book-container').style.display = 'none';
    document.getElementById('library-grid-container').style.display = 'block';
    document.getElementById('library-book-sidebar').style.display = 'none';
    document.getElementById('library-default-sidebar').style.display = 'flex';
}

function changeBookSort(method) {
    currentBookSort = method;
    ['alpha', 'count', 'time'].forEach(m => {
        const btn = document.getElementById(`sort-book-${m}`);
        if(btn) btn.classList.toggle('active', m === method);
    });
    if (currentBookData) renderBookContextSidebar();
}

function renderBookContextSidebar() {
    if (!currentBookData) return;
    const activeContainer = document.getElementById('book-active-tags-container');
    if (bookActiveTags.length === 0) {
        setSafeHTML(activeContainer, '<p class="empty-state-text">No tags selected.</p>');
    } else {
        setSafeHTML(activeContainer, bookActiveTags.map(tag => `<div class="tag-pill tag-active" data-toggle-book-tag="${escapeHTML(tag)}">${escapeHTML(tag)} &nbsp;</div>`).join(''));
    }
    renderTaxonomySidebar(
        document.getElementById('book-context-tags-container'),
        currentBookData,
        bookActiveTags,
        toggleBookTag,
        currentBookSort,
        'No related tags found.'
    );
}

// =========================================================================
// 10. VIEW MODULE: TAG INDEX & TIME METRICS
// =========================================================================
async function openTagsTab() {
    switchView('tags');
    if (absoluteMinMs === 0 || currentTagIndexData.length === 0) {
        document.getElementById('full-tag-index-container').innerHTML = '<p class="empty-state-text-center">Loading index...</p>';
        await fetchTimeMetrics(null, null, true);
    } else {
        renderFlatTagIndex();
    }
}

function initSliders(minDateStr, maxDateStr) {
    const startSlider = document.getElementById('stats-start-slider');
    const endSlider = document.getElementById('stats-end-slider');
    const wasInitialized = startSlider.hasAttribute('data-init');
    const previousMinMs = absoluteMinMs;
    const previousMaxMs = absoluteMaxMs;
    const previousStartDate = wasInitialized ? msToDateStr(previousMinMs + Number(startSlider.value) * 86400000) : minDateStr;
    const previousEndDate = wasInitialized ? msToDateStr(previousMinMs + Number(endSlider.value) * 86400000) : maxDateStr;
    const followedLatestDate = !wasInitialized || previousEndDate === msToDateStr(previousMaxMs);

    absoluteMinMs = new Date(minDateStr + "T00:00:00Z").getTime();
    absoluteMaxMs = new Date(maxDateStr + "T00:00:00Z").getTime();
    const totalDays = Math.max(1, Math.ceil((absoluteMaxMs - absoluteMinMs) / 86400000));

    startSlider.max = totalDays;
    endSlider.max = totalDays;

    const dateOffset = dateStr => {
        const parsed = new Date(dateStr + "T00:00:00Z").getTime();
        return Math.max(0, Math.min(totalDays, Math.round((parsed - absoluteMinMs) / 86400000)));
    };

    startSlider.value = wasInitialized ? dateOffset(previousStartDate) : 0;
    endSlider.value = followedLatestDate ? totalDays : dateOffset(previousEndDate);

    if (!wasInitialized) {
        startSlider.setAttribute('data-init', 'true');
        startSlider.addEventListener('input', handleSliderDrag);
        endSlider.addEventListener('input', handleSliderDrag);
        startSlider.addEventListener('change', handleSliderRelease);
        endSlider.addEventListener('change', handleSliderRelease);
    }
    updateSliderDisplays();
}

function msToDateStr(ms) {
    return new Date(ms).toISOString().split('T')[0];
}

function handleSliderDrag(e) {
    const startSlider = document.getElementById('stats-start-slider');
    const endSlider = document.getElementById('stats-end-slider');

    if (parseInt(startSlider.value) > parseInt(endSlider.value)) {
        if (e.target.id === 'stats-start-slider') startSlider.value = endSlider.value;
        else endSlider.value = startSlider.value;
    }
    updateSliderDisplays();
}

function updateSliderDisplays() {
    const startSlider = document.getElementById('stats-start-slider');
    const endSlider = document.getElementById('stats-end-slider');

    const startMs = absoluteMinMs + parseInt(startSlider.value) * (1000 * 60 * 60 * 24);
    const endMs = absoluteMinMs + parseInt(endSlider.value) * (1000 * 60 * 60 * 24);

    document.getElementById('slider-display-start').textContent = msToDateStr(startMs);
    document.getElementById('slider-display-end').textContent = msToDateStr(endMs);
}

function handleSliderRelease() {
    const startMs = absoluteMinMs + parseInt(document.getElementById('stats-start-slider').value) * (1000 * 60 * 60 * 24);
    const endMs = absoluteMinMs + parseInt(document.getElementById('stats-end-slider').value) * (1000 * 60 * 60 * 24);

    clearTimeout(timeMetricsTimeout);
    timeMetricsTimeout = setTimeout(() => {
        fetchTimeMetrics(msToDateStr(startMs), msToDateStr(endMs), false);
    }, 200);
}

async function fetchTimeMetrics(startDate = null, endDate = null, isInit = false) {
    try {
        const resp = await jsonPost('/api/time_metrics', { start_date: startDate, end_date: endDate });
        const data = await resp.json();
        if (!data.success) return;
        if (isInit) initSliders(data.absolute_min_date, data.absolute_max_date);

        const sortedTags = Object.entries(data.tag_counts || {}).map(([name, count]) => ({ name, count: Number(count) || 0 })).sort((a, b) => b.count - a.count);
        const sortedSources = Object.entries(data.source_counts || {}).map(([name, count]) => ({ name, count: Number(count) || 0 })).sort((a, b) => b.count - a.count);
        const tagsHTML = sortedTags.slice(0, 10).map(item => `<div class="metric-list-item"><span class="metric-list-name" style="color:var(--accent);" title="${escapeHTML(item.name)}" data-open-person="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span><span class="metric-list-count">${item.count}</span></div>`).join('');
        const sourcesHTML = sortedSources.slice(0, 10).map(item => `<div class="metric-list-item"><span class="metric-list-name" style="color:var(--text-main);" title="${escapeHTML(item.name)}" data-open-book="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span><span class="metric-list-count">${item.count}</span></div>`).join('');
        setSafeHTML(document.getElementById('time-period-metrics'), `
            <div class="metric-card metric-card-centered"><div class="metric-header" style="margin-bottom:5px;">Highlights in Period</div><div class="metric-number">${Number(data.total_highlights) || 0}</div></div>
            <div class="metric-card"><div class="metric-header">Top 10 Tags</div>${tagsHTML || '<span class="empty-state-text">No tags recorded in this period.</span>'}</div>
            <div class="metric-card"><div class="metric-header">Top 10 Sources</div>${sourcesHTML || '<span class="empty-state-text">No sources recorded in this period.</span>'}</div>`);
        currentTagIndexData = sortedTags;
        renderFlatTagIndex();
    } catch (error) {
        console.error('Failed to load time metrics', error);
    }
}

function sortTagIndex(method) {
    currentTagIndexSort = method;
    renderFlatTagIndex();
}

function renderFlatTagIndex() {
    const container = document.getElementById('full-tag-index-container');
    if (currentTagIndexSort === 'alpha') {
        currentTagIndexData.sort((a, b) => a.name.localeCompare(b.name));
        document.getElementById('sort-index-alpha').classList.add('active');
        document.getElementById('sort-index-count').classList.remove('active');
    } else {
        currentTagIndexData.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        document.getElementById('sort-index-count').classList.add('active');
        document.getElementById('sort-index-alpha').classList.remove('active');
    }
    const html = currentTagIndexData.length === 0
        ? '<p class="empty-state-text">No tags found for the selected dates.</p>'
        : currentTagIndexData.map(item => `<div class="tag-pill tag-pill-large" data-open-person="${escapeHTML(item.name)}">${escapeHTML(item.name)} <span class="tag-pill-count">${Number(item.count) || 0}</span></div>`).join('');
    setSafeHTML(container, html);
    document.getElementById('filtered-tag-count').textContent = `(${currentTagIndexData.length})`;
}

// =========================================================================
// 11. VIEW MODULE: PERSON PAGE
// =========================================================================
async function openPersonPage(personName) {
    const loadToken = ++personPageLoadToken;
    lastViewedTag = String(personName || '');
    switchView('person');
    document.getElementById('person-name-display').textContent = lastViewedTag;
    document.getElementById('person-blurb-text').textContent = 'Loading Wikipedia data...';
    clearElement(document.getElementById('person-image-container'));
    clearElement(document.getElementById('primary-sources-content'));
    clearElement(document.getElementById('secondary-sources-content'));
    document.getElementById('person-primary-container').style.display = 'none';
    document.getElementById('person-secondary-container').style.display = 'none';
    setSafeHTML(document.getElementById('person-available-tags-container'), '<p class="empty-state-text">Loading related tags...</p>');
    document.getElementById('person-blurb-fade').style.display = 'none';
    document.getElementById('person-blurb-toggle').style.display = 'none';

    const isCurrentLoad = () => loadToken === personPageLoadToken && lastViewedTag === String(personName || '');
    const renderSources = (sources, containerId) => {
        const sourceList = Array.isArray(sources) ? sources : [];
        const books = sourceList.filter(source => source.category === 'books');
        const articles = sourceList.filter(source => ['articles', 'tweets'].includes(source.category));
        const media = sourceList.filter(source => !['books', 'articles', 'tweets'].includes(source.category));
        let html = '';
        if (books.length > 0) {
            html += '<div class="books-grid" style="margin-bottom:0;">';
            html += books.map(book => {
                const title = String(book.title || 'Unknown');
                const author = String(book.author || 'Unknown');
                const coverURL = safeURL(book.cover, { sameOriginOnly: true });
                const cover = coverURL && new URL(coverURL).pathname.startsWith('/api/covers/')
                    ? `<img src="${escapeHTML(coverURL)}" class="book-cover" loading="lazy" alt="">`
                    : '<div class="book-cover-placeholder">No Cover</div>';
                return `<div class="book-card" data-open-book="${escapeHTML(title)}">${cover}<div class="book-title">${escapeHTML(title)}</div><div class="book-author">${escapeHTML(author)}</div></div>`;
            }).join('');
            html += '</div>';
        }
        const textList = (items, heading) => items.length === 0 ? '' : `<h4 class="source-list-title">${heading}</h4><div class="source-list-container">${items.map(item => `<div class="source-list-item" data-open-book="${escapeHTML(item.title || 'Unknown')}"><div class="source-list-item-content"><div class="source-list-item-title">${escapeHTML(item.title || 'Unknown')}</div><div class="source-list-item-author">${escapeHTML(item.author || 'Unknown')}</div></div></div>`).join('')}</div>`;
        html += textList(articles, 'Articles & Text');
        html += textList(media, 'Audio & Video');
        setSafeHTML(document.getElementById(containerId), html);
    };

    const localDataPromise = jsonPost('/api/person', { person: lastViewedTag })
        .then(resp => resp.json())
        .then(personData => {
            if (!isCurrentLoad() || !personData.success) return;
            if ((personData.primary_sources || []).length > 0) {
                document.getElementById('person-primary-container').style.display = 'block';
                personData.primary_sources.sort((a, b) => Number(b.count) - Number(a.count));
                renderSources(personData.primary_sources, 'primary-sources-content');
            }
            if ((personData.secondary_sources || []).length > 0) {
                document.getElementById('person-secondary-container').style.display = 'block';
                personData.secondary_sources.sort((a, b) => Number(b.count) - Number(a.count));
                renderSources(personData.secondary_sources, 'secondary-sources-content');
            }
        })
        .catch(error => console.error('Local person data failed', error));

    const explorePromise = jsonPost('/api/explore', { tags: [lastViewedTag] })
        .then(resp => resp.json())
        .then(exploreData => {
            if (!isCurrentLoad()) return;
            renderTaxonomySidebar(document.getElementById('person-available-tags-container'), exploreData, [], tag => openPersonPage(tag), 'count', 'No other co-occurring tags found.');
        })
        .catch(error => {
            console.error('Related tag data failed', error);
            if (isCurrentLoad()) setSafeHTML(document.getElementById('person-available-tags-container'), '<p class="empty-state-text">Failed to load related tags.</p>');
        });

    const wikiPromise = jsonPost('/api/person/wiki', { person: lastViewedTag })
        .then(resp => resp.json())
        .then(wikiData => {
            if (!isCurrentLoad()) return;
            const imageURL = safeURL(wikiData.wiki?.image_url, { allowedHost: 'upload.wikimedia.org' });
            if (imageURL) {
                const image = document.createElement('img');
                image.src = imageURL;
                image.className = 'person-image';
                image.alt = '';
                document.getElementById('person-image-container').appendChild(image);
            }

            const allTags = currentData ? currentData.all_database_tags : libraryData ? libraryData.all_book_tags : [];
            renderLinkedPlainText(document.getElementById('person-blurb-text'), wikiData.wiki?.blurb || 'No Wikipedia extract found.', allTags, lastViewedTag);

            const blurb = document.getElementById('person-blurb');
            blurb.style.maxHeight = '390px';
            setTimeout(() => {
                if (!isCurrentLoad()) return;
                if (blurb.scrollHeight > 530) {
                    document.getElementById('person-blurb-fade').style.display = 'block';
                    const toggle = document.getElementById('person-blurb-toggle');
                    toggle.style.display = 'block';
                    toggle.textContent = 'Show more ▾';
                }
            }, 100);
        })
        .catch(error => {
            console.error('Wikipedia data failed', error);
            if (isCurrentLoad()) document.getElementById('person-blurb-text').textContent = 'No Wikipedia extract found.';
        });

    await Promise.allSettled([localDataPromise, explorePromise, wikiPromise]);
}

function togglePersonBlurb() {
    const blurb = document.getElementById('person-blurb');
    const fade = document.getElementById('person-blurb-fade');
    const btn = document.getElementById('person-blurb-toggle');

    if (blurb.style.maxHeight === '390px') {
        blurb.style.maxHeight = '5000px';
        fade.style.display = 'none';
        btn.textContent = 'Show less ▴';
    } else {
        blurb.style.maxHeight = '390px';
        fade.style.display = 'block';
        btn.textContent = 'Show more ▾';
        blurb.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// =========================================================================
// 12. VIEW MODULE: STUDY (SRS)
// =========================================================================
document.getElementById('srs-tag-input').addEventListener('input', function(e) {
    if (e.inputType === "insertReplacementText" || e.inputType == null) {
        const val = this.value.trim();
        if (val && currentData && currentData.all_database_tags.includes(val)) {
            if (!srsActiveTags.includes(val)) {
                srsActiveTags.push(val);
                renderSrsActiveTags();
                fetchNextSRS();
            }
            this.value = '';
        }
    }
});

document.getElementById('srs-tag-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        const val = this.value.trim();
        if (val && !srsActiveTags.includes(val)) {
            srsActiveTags.push(val);
            renderSrsActiveTags();
            fetchNextSRS();
        }
        this.value = '';
    }
});

function removeSrsTag(tag) {
    srsActiveTags = srsActiveTags.filter(t => t !== tag);
    renderSrsActiveTags();
    fetchNextSRS();
}

function renderSrsActiveTags() {
    setSafeHTML(document.getElementById('srs-active-tags'), srsActiveTags.map(tag => `<div class="tag-pill tag-active" data-remove-srs-tag="${escapeHTML(tag)}">${escapeHTML(tag)} &nbsp;</div>`).join(''));
}

function debounceSRSFetch() {
    clearTimeout(srsFetchTimeout);
    srsFetchTimeout = setTimeout(fetchNextSRS, 500);
}

function skipSRSCard() {
    if (currentSrsHighlightId) {
        sessionSkippedIds.push(currentSrsHighlightId);
        fetchNextSRS();
    }
}

async function fetchNextSRS() {
    const container = document.getElementById('srs-card-container');
    setSafeHTML(container, '<p class="empty-state-text-center">Fetching next due highlight...</p>');
    const payload = {
        book: document.getElementById('srs-book-input').value,
        tags: srsActiveTags,
        yesterday: document.getElementById('srs-yesterday-toggle').checked,
        ignore_date: document.getElementById('srs-ignore-toggle').checked,
        skipped_ids: sessionSkippedIds,
    };
    try {
        const resp = await jsonPost('/api/srs/next', payload);
        const data = await resp.json();
        if (!data.success) {
            setSafeHTML(container, `<div class="srs-empty-state"><h3 class="srs-empty-title">You're all caught up!</h3><p class="srs-empty-text">${escapeHTML(data.error || 'No more highlights.')}</p></div>`);
            currentSrsHighlightId = null;
            return;
        }
        const hl = data.highlight;
        currentSrsHighlightId = hl.highlight_id;
        const card = createHighlightCard(hl, true, 'study');
        card.classList.add('srs-mode-card');
        insertSafeHTML(card, 'afterbegin', `<span class="srs-priority-badge">Priority: ${escapeHTML(hl.srs?.priority ?? '')}</span>`);
        insertSafeHTML(card, 'beforeend', `<div class="srs-controls">${[0,1,2,3,4,5].map(rating => `<button class="rate-btn rate-${rating}" data-srs-rating="${rating}" type="button">${rating}${rating === 0 ? ' - Hard' : rating === 3 ? ' - Good' : rating === 5 ? ' - Easy' : ''}</button>`).join('')}</div>`);
        clearElement(container);
        container.appendChild(card);
    } catch (error) {
        console.error('SRS fetch failed', error);
        setSafeHTML(container, '<p class="empty-state-text-center" style="color:var(--danger);">Error connecting to DB.</p>');
    }
}

async function submitSRSRating(rating) {
    if (!currentSrsHighlightId) return;

    const idToRate = currentSrsHighlightId;
    currentSrsHighlightId = null;

    const container = document.getElementById('srs-card-container');
    container.style.opacity = '0.5';

    try {
        await fetch('/api/srs/rate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ highlight_id: idToRate, rating: rating })
        });
        sessionReviewCount++;
        document.getElementById('srs-session-count').textContent = sessionReviewCount;
        container.style.opacity = '1';
        fetchNextSRS();
    } catch (e) {
        alert("Failed to submit rating.");
        container.style.opacity = '1';
        currentSrsHighlightId = idToRate;
    }
}

// =========================================================================
// 13. VIEW MODULE: MAP
// =========================================================================
async function initMap() {
    if (!graphData) {
        const resp = await fetch('/api/graph');
        graphData = await resp.json();
    }
    drawMap();
}

function updateMapFilter() {
    const radios = document.getElementsByName('map-filter');
    for (let r of radios) {
        if (r.checked) { currentGraphFilter = r.value; break; }
    }
    drawMap();
}

function drawMap() {
    const container = document.getElementById('d3-map-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    d3.select("#force-graph").selectAll("*").remove();
    if (graphSimulation) graphSimulation.stop();

    let nodes = graphData.nodes.map(d => Object.create(d));
    let links = graphData.links.map(d => Object.create(d));

    if (currentGraphFilter === 'people') {
        nodes = nodes.filter(n => n.group === 'Person');
        const validIds = new Set(nodes.map(n => n.id));
        links = links.filter(l => validIds.has(l.source) && validIds.has(l.target));
    } else if (currentGraphFilter === 'ideas') {
        nodes = nodes.filter(n => n.group !== 'Person');
        const validIds = new Set(nodes.map(n => n.id));
        links = links.filter(l => validIds.has(l.source) && validIds.has(l.target));
    }

    const svg = d3.select("#force-graph").attr("viewBox", [0, 0, width, height]);
    const g = svg.append("g");

    svg.call(d3.zoom().extent([[0, 0], [width, height]]).scaleExtent([0.1, 4]).on("zoom", (event) => { g.attr("transform", event.transform); }));
    const tooltip = d3.select("#map-tooltip");
    const colorMap = { "Person": "#89b4fa", "Idea": "#cba6f7", "Period & Region": "#a6e3a1" };

    graphSimulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(100))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collide", d3.forceCollide().radius(d => Math.sqrt(d.val) * 2 + 15));

    const link = g.append("g").attr("class", "links").selectAll("line").data(links).join("line").attr("stroke-width", d => Math.sqrt(d.value)).attr("class", "link");
    const node = g.append("g").attr("class", "nodes").selectAll("circle").data(nodes).join("circle").attr("r", d => Math.sqrt(d.val) * 1.5 + 4).attr("fill", d => colorMap[d.group] || "#f38ba8").call(drag(graphSimulation))
        .on("mouseover", (event, d) => {
            tooltip.style("opacity", 1).html(sanitizeAppHTML(`<strong>${escapeHTML(d.id)}</strong><br/><span style="color:var(--text-muted); font-size:0.9em">${escapeHTML(d.group)} (${Number(d.val) || 0} items)</span>`)).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 10) + "px");
        })
        .on("mouseout", () => { tooltip.style("opacity", 0); })
        .on("click", (event, d) => { selectSearchTag(d.id); });

    const labels = g.append("g").attr("class", "labels").selectAll("text").data(nodes).join("text").attr("class", "node-label").attr("dy", d => Math.sqrt(d.val) * 1.5 + 16).text(d => d.id);

    graphSimulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("cx", d => d.x).attr("cy", d => d.y);
        labels.attr("x", d => d.x).attr("y", d => d.y);
    });

    function drag(simulation) {
        function dragstarted(event) { if (!event.active) simulation.alphaTarget(0.3).restart(); event.subject.fx = event.subject.x; event.subject.fy = event.subject.y; }
        function dragged(event) { event.subject.fx = event.x; event.subject.fy = event.y; }
        function dragended(event) { if (!event.active) simulation.alphaTarget(0); event.subject.fx = null; event.subject.fy = null; }
        return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
    }
}

// =========================================================================
// 14. TAXONOMY CONFIGURATION MODAL
// =========================================================================
async function openTaxonomyConfig() {
    document.getElementById('taxonomy-overlay').style.display = 'flex';
    try {
        const resp = await fetch('/api/taxonomy/config');
        const config = await resp.json();

        document.getElementById('tax-provider').value = config.provider || 'gemini';
        document.getElementById('tax-categories').value = (config.categories || []).join(', ');
        document.getElementById('tax-fields').value = (config.fields || []).join(', ');
        document.getElementById('tax-roles').value = (config.roles || []).join(', ');
    } catch (e) {
        console.error("Failed to fetch taxonomy config", e);
    }
}

function closeTaxonomyConfig(e) {
    if (e && e.target !== document.getElementById('taxonomy-overlay') && e.target.closest('.search-modal')) return;
    document.getElementById('taxonomy-overlay').style.display = 'none';
}

async function saveTaxonomyConfig() {
    const config = {
        provider: document.getElementById('tax-provider').value,
        categories: document.getElementById('tax-categories').value.split(',').map(s => s.trim()).filter(s => s),
        fields: document.getElementById('tax-fields').value.split(',').map(s => s.trim()).filter(s => s),
        roles: document.getElementById('tax-roles').value.split(',').map(s => s.trim()).filter(s => s)
    };

    const btn = document.getElementById('save-tax-btn');
    const origText = btn.textContent;
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        await fetch('/api/taxonomy/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        closeTaxonomyConfig();
    } catch (e) {
        alert("Failed to save configuration.");
    } finally {
        btn.textContent = origText;
        btn.disabled = false;
    }
}

async function triggerTaxonomer() {
    const icon = document.getElementById('tax-icon');
    const origColor = icon.style.fill;
    icon.style.fill = "var(--accent)";
    icon.style.transform = "rotate(180deg)";

    try {
        const resp = await jsonPost('/api/taxonomy/run');
        const data = await resp.json();
        if (data.success) {
            alert("Taxonomer script started in the background. Check your server terminal window for progress and logs.");
        } else {
            alert("Failed to start taxonomer: " + data.error);
        }
    } catch (e) {
        alert("Network error.");
    }

    setTimeout(() => {
        icon.style.fill = origColor;
        icon.style.transform = "rotate(0deg)";
    }, 1000);
}
