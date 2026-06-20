# Ticket-to-PR Admin Design Reference

> Clean SaaS data console, adapted from the Clearbit-style Refero reference.

## Direction

The admin UI is an operational dashboard, not a marketing surface. The design should stay quiet, tabular, and easy to scan under debugging pressure. The selected direction uses a paper canvas, midnight ink text, a single blue action color, and light frost borders. Blue is reserved for primary actions, selected rows, links, focus states, and progress indicators.

Source reference: https://styles.refero.design/style/6221ba67-26e7-4657-91b7-efd77cbb1f12

## Tokens

| Name           | Value     | Use                                         |
| -------------- | --------- | ------------------------------------------- |
| Midnight Ink   | `#091135` | Primary text, headings, failure/dark badges |
| Electric Blue  | `#0f77ff` | Links, active progress, focus rings         |
| Cobalt Surface | `#127ee3` | Primary buttons and selected action icons   |
| Slate          | `#36394a` | Secondary text                              |
| Frost Border   | `#e1e9f0` | Card, table, and input borders              |
| Lavender Wash  | `#f5f3ff` | Page background and low-emphasis surfaces   |
| Paper          | `#ffffff` | Cards, tables, inputs, nav                  |

## Typography

Use Inter for every UI surface. Avoid display-serif or decorative type in the admin panel. Typical sizes:

| Role          | Size    | Weight  |
| ------------- | ------- | ------- |
| Page title    | 24-26px | 600     |
| Section title | 18px    | 600     |
| Table body    | 13px    | 400-500 |
| Metadata      | 11-12px | 400-500 |
| Monospace IDs | 11-12px | 400     |

## Components

- App shell: use a persistent left sidebar for product identity, the single top-level Jobs tab, admin access-key utilities, language controls, and static footer copy.
- Page header: show only the current page title, optional job context, a back icon on detail pages, and compact job metrics. Do not place admin token controls in the page header.
- Cards: paper background, 12px radius, 1px frost border, no shadow.
- Tables: compact rows, 13px body text, sticky headers where useful, selected rows use a pale blue wash and a cobalt left rail.
- Buttons: cobalt filled primary, paper outline secondary. Use icon-only controls for repetitive row actions.
- Admin access-key actions: keep Apply and Refresh as text buttons because they submit a form and need explicit labels.
- Inputs: paper background, 8px radius, frost border, electric blue focus ring.
- Badges: keep status badges compact. Use blue wash for normal/review states and midnight ink for failures.
- Trace detail: show a compact progress stepper first, then a table for span/event details. Do not put long error messages inside the top stepper.

## Do

- Keep the list page sparse: time, job UUID, repository, result, action.
- Put long failure messages in the detail table/log sections.
- Keep footer copy static. Runtime status belongs near the control that produced it, not in the footer.
- Use blue sparingly so selected state and action affordances remain obvious.
- Keep spacing tight enough for debugging workflows.

## Do Not

- Do not return to the green clinic palette for operational screens.
- Do not expose trace as a separate sidebar section; it is a detail state under Jobs.
- Do not use large cards for every step in a trace flow.
- Do not show branch names, latest events, or long summaries on the job list.
- Do not put explanatory helper copy in the visible UI when labels and structure are sufficient.
- Do not add shadows or gradients to imply hierarchy.
