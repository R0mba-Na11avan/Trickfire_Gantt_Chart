# TrickFire Gantt

Schedule editor for the TrickFire Robotics URC 2027 Integrated Master Schedule (PDR page 4).
No install, no build: open `index.html` in Chrome or Edge.

## Workflow

1. Edit tasks in the grid (name, owner, start, end, days, % complete, "Depends on").
   Drag bars in the timeline to move them; drag bar ends to resize.
2. Build the WBS with Indent / Outdent. A task with subtasks becomes a summary; its dates and % roll up.
3. Link tasks by typing predecessor WBS numbers in "Depends on": `2.1`, `2.1, 3.2`, `2.1+3` (3 days lag).
   The critical path (zero-float chain to the last task) is computed from these links and drawn in pink.
4. Star a task to mark it URC2027-specific. Diamond toggles a milestone.
5. **Export PDR page** → Print / Save as PDF (destination "Save as PDF", margins None, background graphics on),
   or download PNG / SVG. Collapse summary groups to hide detail rows if the page gets crowded.

## Sharing

Hosted app: https://r0mba-na11avan.github.io/Trickfire_Gantt_Chart/

- Work autosaves in each person's browser only. The app starts empty until a chart is opened.
- **File → Save chart** downloads the schedule as a `.json` file. Send it to a teammate; they use
  **Open chart** to load it.
- `schedule/ims.json` is the team schedule. **Open team schedule** on the hosted app loads the committed copy.
  To publish an update, save the chart and commit it over `schedule/ims.json`.
- No live co-editing: one person owns the master file at a time.

The built-in template is a placeholder: task names, dates, owners and the "(set date)" milestones must be
replaced with the team's real plan and the official URC deadlines.

## Code

| File | Role |
| --- | --- |
| `js/dates.js` | ISO date math on UTC day numbers |
| `js/model.js` | Project/task model, WBS rows, rollups, immutable edits, template |
| `js/cpm.js` | Critical path (backward pass, float), violations, auto-schedule |
| `js/store.js` | localStorage, JSON, CSV, undo history |
| `js/render.js` | SVG timeline (interactive) and export page |
| `js/export.js` | PDF print, PNG, SVG download |
| `js/app.js` | Editor UI |

Tests: `node --test`
