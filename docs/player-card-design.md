# Player-card design pass

Guided by [Unslop](https://github.com/heydamir/unslop), created by
[Damir Sokolovsky](https://x.com/heydamir), CC BY 4.0.

## Audit and direction

The existing graphite theme already works. This is a polish pass around the
requested playback features, keeping the section order and link form.

- Wide text transport buttons compete with the media information.
- Wrapping titles change the reading rhythm between cards.
- Artwork, timeline, and status text need reserved slots to avoid layout shifts.
- The spectrum can be shorter once the cards include a timeline.

Product: a home-audio remote for the Pi's two playback services.
Character: calm, tactile, precise.
World: the front panel of a home stereo.
Moments: current artwork and measured audio spectra.
Signature: the existing restrained green meters shared by both players.

## Passes

1. Spacing: shared rows, 24 px desktop padding, 16 px metadata gaps, 48 px controls.
2. Color: retain graphite surfaces and green levels; artwork carries other color.
3. Icons: one embedded Lucide set, consistent stroke, accessible labels and tooltips.
4. Copy: keep the page and link-form wording; concise title and status fallbacks.
5. Type: one fixed title line and one subtitle line; tabular times and percentages.
6. Layout: identical player anatomy; square artwork slots preserve image aspect ratio.
7. Details: preserve placeholder, timeline, and message rows in all player states.
8. Visuals: real media artwork with a neutral music-note placeholder; no generated art.
9. Motion: title scrolling only on overflow, with pauses and reduced-motion support;
   real audio bars remain reactive. All movement uses transforms, never layout dimensions.

## Verification

The desktop preview measured both cards at 434 px height and document top 334 px
before and after mute, idle, and unavailable states. Artwork slots stayed 84 × 84 px.
The phone layout uses 72 × 72 px artwork and preserves 48 px controls. Keyboard seeking
and mute were exercised on fake players; the live Pi's audible controls are left to
the owner to test. Tests cover native seek units, media-ID mismatch rejection, volume
restoration after restart, live-stream limits, and artwork source validation.
