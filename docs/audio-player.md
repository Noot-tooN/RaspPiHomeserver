# Audio player design

The desktop player aligns the track title with the top of the cover and the
YouTube actions with its bottom. On narrow screens the cover and controls stack.
Both players reserve space for artwork, metadata and the spectrum so those
elements can change during playback without moving the controls.

Play leads the transport row, followed by Previous/Next, Back/Forward 15 seconds
and the player volume. The master volume and service restarts live in Settings.
The YouTube tab opens with the link field selected. Selecting Link a phone shows
a recent code or requests a new one, which can interrupt YouTube playback.

The local test fixture uses synthetic audio data to animate the spectrum. To run it
from `apps/control-panel`:

```sh
RASPPI_PANEL_PREVIEW=1 go test -run '^TestPreview$' -timeout 8h
```

Open the preview at <http://127.0.0.1:8098/>.

Design guided by [Unslop](https://github.com/heydamir/unslop), by
[Damir Sokolovsky](https://x.com/heydamir), CC BY 4.0. The Spotify and YouTube
glyphs come from [Simple Icons](https://github.com/simple-icons/simple-icons)
(CC0).
