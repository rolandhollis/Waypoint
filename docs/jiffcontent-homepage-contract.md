# JiffContent Contract: Homepage + Navbar

Waypoint homepage prefers a **published JiffContent page + layout**.

## Homepage (page resolve)

1. Create a **Layout** in Admin → Layouts and **publish** it.
2. Create a **Page** in Admin → Pages with path `/` (or your chosen path) and assign that layout.
3. Waypoint calls `GET /v1/pages/resolve?path=/` and renders the layout grid (`jc.raw_text`, `jc.rich_html`, `jc.image`, plus registered `brand.*` blocks).

### Registered `brand.*` blocks

| Block type | Renders |
|------------|---------|
| `brand.home_hero` | ZiffSplit/home hero (`home_hero` container) |
| `brand.projects_overview` | Projects summary card; copy via placements (`projects_*` labels); optional prop `page_name` |
| `brand.updates_per_user` | Updates-per-user chart; copy via placements (`updates_per_user_*` labels); own date range; optional prop `page_name` |
| `brand.active_assignments_by_pm` | Active assignments by PM; copy via placements (`active_assignments_*` labels); own date range; optional prop `page_name` |
| `brand.home_activity_chart` | Activity chart slot (`home_activity_chart`); optional props `day_title`, `user_title` |
| `brand.home_assignments` | Legacy alias for assignments chart; prefer `brand.active_assignments_by_pm` |

Env:

```bash
VITE_JIFFCONTENT_PUBLIC_KEY=jc_pk_…
VITE_JIFFCONTENT_API_BASE=http://localhost:4200   # local
# Optional path override (default /)
# VITE_JIFFCONTENT_HOME_PATH=/
```

If CMS is unset, resolve fails, or the layout isn’t published, Waypoint falls back to the built-in homepage UI below.

## Fallback: placement labels (`page_name=homepage`)

Used only when no published page layout is available. All slots optional.

### Hero

- `home_hero_image` (`image`)
- `home_hero_title` (`raw_text`)
- `home_hero_subtitle` (`raw_text`)

### Section visibility / order

- `home_show_projects` / `home_show_activity` / `home_show_assignments` (`raw_text` boolean-ish)
- `home_section_order` (`raw_text`) — comma-separated: `projects`, `activity`, `assignments`

### Copy slots

- `home_projects_title`, `home_projects_subtitle`, `home_projects_total_label`, `home_projects_in_progress_label`
- `home_activity_day_title`, `home_activity_user_title`
- `home_assignments_title`, `home_assignments_subtitle`

### Layout brand blocks (preferred): placement copy on `page_name=homepage`

**`brand.projects_overview`**

- `projects_title`, `projects_description`, `projects_total_label`, `projects_in_progress_label`
- `projects_loading_text`, `projects_error_text`

**`brand.updates_per_user`**

- `updates_per_user_title`, `updates_per_user_loading_text`
- `updates_per_user_error_text`, `updates_per_user_empty_text`

**`brand.active_assignments_by_pm`**

- `active_assignments_title`, `active_assignments_description`
- `active_assignments_loading_text`, `active_assignments_error_text`, `active_assignments_empty_text`

## Navbar (`page_name=shell`)

Still placement-driven (not the homepage page):

- `navbar_component` — `brand.navbar` to show app nav
- `navbar_enabled`, `navbar_show_group_switcher`, `navbar_show_user_switcher`
- `navbar_announcement`

## Notes

- Browser integration uses `VITE_JIFFCONTENT_PUBLIC_KEY` (`jc_pk_…`) only.
- Public key must allowlist app origins (`http://localhost:5173`, production host).
- Layout must be **published** for `/v1/pages/resolve` to return a renderable document.
