# Frontend

- `public/` is plain HTML/CSS/JS served as Workers Static Assets. It has no build step and no framework, so don't add one.
- Design tokens live in `public/tokens.css`. Use them instead of hard-coded colors or sizes.
- The visual style is the Hallmark "Brutal" theme with the "Workbench" app-shell layout (see `.hallmark/log.json`). For design work, use the `hallmark` skill in `.agents/skills/hallmark/`.
