//! Where the notch goes and when the pointer counts as on it, as plain numbers. Coordinates are
//! AppKit's unless a comment says otherwise: points, origin at the primary screen's bottom-left,
//! y up.

use serde::{Deserialize, Serialize};

/// The panel's fixed size; the shapes animate inside it (`ui/notch/layout.json`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct PanelSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// What `NSScreen` reports for one display.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ScreenMetrics {
    pub frame: Rect,
    /// `visibleFrame`'s top edge: below the menu bar, or the screen top when it is hidden.
    pub visible_top: f64,
    pub safe_area_top: f64,
    pub aux_left_width: f64,
    pub aux_right_width: f64,
}

/// What the page needs to line its shapes up with the hardware.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Housing {
    /// 0 on a screen without a notch: the shapes then float as capsules.
    pub width: f64,
    /// The band the pills fill: the notch, else the floating height.
    pub height: f64,
    /// Distance from the panel's top to pill 1: a floating pill sits below the menu bar.
    pub top: f64,
    /// The camera or the screen's centre, from the panel's left edge. Off the panel's middle only
    /// when the screen is narrower than the panel.
    pub centre: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub origin_x: f64,
    pub origin_y: f64,
    pub housing: Housing,
}

const FLOATING_HEIGHT: f64 = 32.0;
const FLOATING_GAP: f64 = 6.0;

/// A notch needs both reported ears: an external display answers zero insets, and a safe area with
/// no ears is not a camera housing. The panel centres on the housing, not the screen, and never
/// crosses onto the neighbouring display.
pub fn place(screen: &ScreenMetrics, panel: PanelSize) -> Placement {
    let frame = screen.frame;
    let top = frame.y + frame.height;
    let notched = screen.safe_area_top > 0.0 && screen.aux_left_width > 0.0 && screen.aux_right_width > 0.0;
    let (centre, (width, height, housing_top)) = if notched {
        let width = (frame.width - screen.aux_left_width - screen.aux_right_width).max(0.0);
        (frame.x + screen.aux_left_width + width / 2.0, (width, screen.safe_area_top, 0.0))
    } else {
        let bar = (top - screen.visible_top).max(0.0);
        (frame.x + frame.width / 2.0, (0.0, FLOATING_HEIGHT, bar + FLOATING_GAP))
    };
    let origin_x = (centre - panel.width / 2.0).min(frame.x + frame.width - panel.width).max(frame.x);
    Placement { origin_x, origin_y: top - panel.height, housing: Housing { width, height, top: housing_top, centre: centre - origin_x } }
}

/// The display a point is on, or the first one when it is on none (a just-removed display).
/// `mouseLocation` reaches `frame.maxY` on the top row of pixels, which a half-open rect leaves out.
pub fn screen_at(screens: &[ScreenMetrics], x: f64, y: f64) -> Option<usize> {
    if screens.is_empty() {
        return None;
    }
    let on_top_row = |screen: &ScreenMetrics| {
        let frame = screen.frame;
        y == frame.y + frame.height && x >= frame.x && x < frame.x + frame.width
    };
    let index = screens.iter().position(|screen| screen.frame.contains(x, y)).or_else(|| screens.iter().position(on_top_row));
    Some(index.unwrap_or(0))
}

/// `rects` are the page's: top-left origin, CSS pixels. The pointer is AppKit's.
pub fn pointer_on_shape(rects: &[Rect], placement: &Placement, panel: PanelSize, x: f64, y: f64) -> bool {
    let (local_x, local_y) = (x - placement.origin_x, placement.origin_y + panel.height - y);
    rects.iter().any(|rect| rect.contains(local_x, local_y))
}

/// Dwell before opening, so crossing the notch on the way to the menu bar opens nothing.
pub const OPEN_DWELL_MS: u64 = 140;
/// Grace before closing, so a pointer that slips off an edge does not fold the list under it.
pub const CLOSE_GRACE_MS: u64 = 380;
/// How long a click from pill 2, which the list does not cover, gives the pointer to reach it.
pub const CLICK_HOLD_MS: u64 = 2500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Hover {
    pub expanded: bool,
    /// When the pointer last crossed to the side opposite `expanded`.
    pending_since: Option<u64>,
    /// Off the shape counts for nothing before this.
    held_until: u64,
    /// Dismissed under the pointer: nothing opens until it has left.
    disarmed: bool,
}

impl Hover {
    /// A click on a pill: opens now, with no dwell.
    pub fn open(&mut self, now_ms: u64) {
        *self = Hover { expanded: true, held_until: now_ms + CLICK_HOLD_MS, ..Hover::default() };
    }

    pub fn close(&mut self) {
        *self = Hover::default();
    }

    /// Closed by a click on a manager, with the pointer still where the list was.
    pub fn dismiss(&mut self) {
        *self = Hover { disarmed: true, ..Hover::default() };
    }

    /// One pointer sample. Returns the new `expanded` when it changed.
    pub fn step(&mut self, on_shape: bool, now_ms: u64) -> Option<bool> {
        if self.disarmed {
            self.disarmed = on_shape;
            return None;
        }
        if on_shape == self.expanded || (self.expanded && now_ms < self.held_until) {
            self.pending_since = None;
            return None;
        }
        let since = *self.pending_since.get_or_insert(now_ms);
        let wait = if on_shape { OPEN_DWELL_MS } else { CLOSE_GRACE_MS };
        if now_ms.saturating_sub(since) < wait {
            return None;
        }
        self.expanded = on_shape;
        self.pending_since = None;
        Some(on_shape)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: PanelSize = PanelSize { width: 800.0, height: 360.0 };
    /// MacBook Pro 14" at its default scale.
    const NOTCHED: ScreenMetrics = ScreenMetrics {
        frame: Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
        visible_top: 945.0,
        safe_area_top: 37.0,
        aux_left_width: 654.0,
        aux_right_width: 658.0,
    };
    const EXTERNAL: ScreenMetrics = ScreenMetrics {
        frame: Rect { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 },
        visible_top: 1215.0,
        safe_area_top: 0.0,
        aux_left_width: 0.0,
        aux_right_width: 0.0,
    };

    #[test]
    fn a_notched_screen_centres_on_the_housing_not_the_screen() {
        let placed = place(&NOTCHED, PANEL);
        assert_eq!(placed.housing, Housing { width: 200.0, height: 37.0, top: 0.0, centre: 400.0 });
        assert_eq!(placed.origin_x, 754.0 - 400.0);
        assert_eq!(placed.origin_y + PANEL.height, 982.0);
    }

    #[test]
    fn no_notch_floats_a_pill_at_top_centre_below_the_menu_bar() {
        let placed = place(&EXTERNAL, PANEL);
        assert_eq!(placed.housing.width, 0.0);
        assert_eq!(placed.housing.top, 25.0 + 6.0);
        assert_eq!(placed.origin_x + PANEL.width / 2.0, 1512.0 + 1280.0);
        assert_eq!(placed.origin_y + PANEL.height, 1240.0);
    }

    #[test]
    fn a_hidden_menu_bar_lets_the_pill_rise() {
        let full_screen = ScreenMetrics { visible_top: 1240.0, ..EXTERNAL };
        assert_eq!(place(&full_screen, PANEL).housing.top, 6.0);
    }

    #[test]
    fn a_safe_area_without_ears_is_not_a_notch() {
        let earless = ScreenMetrics { safe_area_top: 24.0, ..EXTERNAL };
        assert_eq!(place(&earless, PANEL).housing.width, 0.0);
    }

    #[test]
    fn the_panel_stays_on_a_screen_narrower_than_itself() {
        let tiny = ScreenMetrics { frame: Rect { x: 100.0, y: 0.0, width: 600.0, height: 500.0 }, visible_top: 475.0, ..Default::default() };
        let placed = place(&tiny, PANEL);
        assert_eq!(placed.origin_x, 100.0);
        // The shapes follow the screen's centre, not the panel's.
        assert_eq!(placed.housing.centre, 300.0);
    }

    #[test]
    fn the_pointer_picks_the_display_even_below_the_primary() {
        let screens = [NOTCHED, EXTERNAL];
        assert_eq!(screen_at(&screens, 100.0, 100.0), Some(0));
        assert_eq!(screen_at(&screens, 2000.0, -100.0), Some(1));
        assert_eq!(screen_at(&screens, -5000.0, 0.0), Some(0));
        assert_eq!(screen_at(&[], 0.0, 0.0), None);
        // The top row of pixels, on a display that is not the first.
        assert_eq!(screen_at(&screens, 2000.0, 1240.0), Some(1));
    }

    #[test]
    fn the_shape_is_hit_tested_in_page_coordinates() {
        let placed = place(&NOTCHED, PANEL);
        let rects = [Rect { x: 300.0, y: 0.0, width: 200.0, height: 37.0 }];
        // The panel's top is the screen's top, so a point 10pt down is page y = 10.
        assert!(pointer_on_shape(&rects, &placed, PANEL, placed.origin_x + 350.0, 972.0));
        assert!(!pointer_on_shape(&rects, &placed, PANEL, placed.origin_x + 350.0, 900.0));
        assert!(!pointer_on_shape(&rects, &placed, PANEL, placed.origin_x + 100.0, 972.0));
    }

    #[test]
    fn crossing_the_shape_opens_nothing() {
        let mut hover = Hover::default();
        assert_eq!(hover.step(true, 0), None);
        assert_eq!(hover.step(true, 70), None);
        assert_eq!(hover.step(false, 100), None);
        assert_eq!(hover.step(true, 170), None);
        assert_eq!(hover.step(true, 170 + OPEN_DWELL_MS), Some(true));
    }

    #[test]
    fn a_slip_off_the_edge_does_not_close() {
        let mut hover = Hover::default();
        assert_eq!(hover.step(true, 0), None);
        assert_eq!(hover.step(true, OPEN_DWELL_MS), Some(true));
        assert_eq!(hover.step(false, 1000), None);
        assert_eq!(hover.step(true, 1200), None);
        assert_eq!(hover.step(false, 1300), None);
        assert_eq!(hover.step(false, 1300 + CLOSE_GRACE_MS), Some(false));
    }

    #[test]
    fn a_click_needs_no_dwell() {
        let mut hover = Hover::default();
        assert_eq!(hover.step(true, 0), None);
        hover.open(1);
        assert!(hover.expanded);
        assert_eq!(hover.step(true, 2), None);
    }

    #[test]
    fn a_click_from_pill_two_waits_for_the_pointer_but_not_forever() {
        let mut hover = Hover::default();
        hover.open(0);
        assert_eq!(hover.step(false, CLICK_HOLD_MS - 1), None);
        assert_eq!(hover.step(false, CLICK_HOLD_MS), None);
        assert_eq!(hover.step(false, CLICK_HOLD_MS + CLOSE_GRACE_MS), Some(false));
    }

    #[test]
    fn a_dismissed_list_stays_shut_until_the_pointer_leaves() {
        let mut hover = Hover::default();
        hover.open(0);
        hover.dismiss();
        assert_eq!(hover.step(true, 1), None);
        assert_eq!(hover.step(true, 10_000), None);
        assert_eq!(hover.step(false, 10_001), None);
        assert_eq!(hover.step(true, 10_002), None);
        assert_eq!(hover.step(true, 10_002 + OPEN_DWELL_MS), Some(true));
    }
}
