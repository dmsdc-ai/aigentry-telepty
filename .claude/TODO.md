# Telepty TODO

## Critical Fix
- [ ] **Remove `kitty @ send-key` usage entirely** — send-key activates CSI u keyboard protocol, corrupting all terminal input. Replace with `kitty @ send-text $'\r'` for Enter delivery. Affects: daemon.js busAutoRoute() and inject endpoint kitty backup.

## P2 Follow-up
- [ ] Allow bridge queue flush timeout: ensure all bridges run 0.1.41+ code
- [ ] Claude tab title: kitty tab_title_template or periodic set-tab-title
