# Bookmark Feature Contract

**Created**: 2026-01-15
**Confidence Score**: 96/100
**Status**: Approved

## Problem Statement

Users of the Acme Reader app have no way to save articles for later. They resort to browser bookmarks or copy-pasting URLs into notes, losing context about why they saved an item. Power users report spending 5-10 minutes per session re-finding articles they read previously.

## Goals

1. **Enable saving articles** with one-click bookmarking from any article view
2. **Support organization via tags** — user-created tags with autocomplete from existing tags
3. **Add search within bookmarks** — full-text search across saved article titles and tags
4. **Maintain offline access** — bookmarked articles available without network connectivity

## Success Criteria

- [ ] Users can bookmark/unbookmark any article from the article view
- [ ] Users can create, rename, and delete tags
- [ ] Users can assign multiple tags to a bookmark
- [ ] Search returns results within 200ms for up to 1,000 bookmarks
- [ ] Bookmarked articles load fully when offline
- [ ] Bookmarks sync across devices within 30 seconds when online

## Scope Boundaries

### In Scope

- Bookmark CRUD operations
- Tag management (create, rename, delete, assign to bookmarks)
- Full-text search across bookmarks
- Offline storage of bookmarked article content
- Cross-device sync via existing user account system

### Out of Scope

- Sharing bookmarks with other users — deferred to future project
- Bookmark folders or hierarchical organization — tags are sufficient for v1
- Import/export of bookmarks — low priority, revisit after launch
- Analytics on bookmark usage — not needed for v1

### Future Considerations

- Social bookmarking (share collections with friends)
- Smart tags (auto-suggested based on article content)
- Bookmark digest emails (weekly summary of saved items)
