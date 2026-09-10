# PatchcordAppAudio

Lets native Discord's screenshare capture specific applications' audio
(one, several, or your whole system minus excluded apps), instead of only
being able to share the whole system's default audio output as one blob.

## The problem

Discord's own "Stream With Audio" checkbox always captures whatever plays
through the system's **default** audio output as a whole. There's no
built-in way to say "share my screen, but only send this one app's
sound" -- e.g. streaming a game while muting a Discord call's own sound,
or sharing a video call app's audio without also picking up background
music.

## How Discord's native Linux screenshare actually works

This took real reverse-engineering to pin down, documented in detail in
this plugin's own source comments (`index.tsx`, `preload.ts`). Short
version: under Wayland, native Discord's desktop client does **not**
use the standard Web `getDisplayMedia()` API at all. It calls straight
into a native N-API addon (`discord_voice.node`) via
`setNativeScreenSharePickerCallbacks`, which talks directly to
`BaseCapturerPipeWire` in C++ -- confirmed via `strings` on the addon
and extensive live testing; multiple earlier interception attempts on
`getDisplayMedia`/`setDesktopSourceWithOptions` were tried and
abandoned once this was understood.

Because of this, and because of an unrelated but equally important
Electron `contextBridge` quirk (`DiscordNative.nativeModules.
requireModule(name)` returns a **fresh structured-clone every call**, so
patching the native module from ordinary renderer code silently patches
nothing anyone else ever sees), the actual native-module patch has to
run in Electron's **preload** context, before contextBridge ever clones
the native `discord_voice` module out:

- **This plugin's own `preload.ts`**: intercepts Discord's own
  `contextBridge.exposeInMainWorld("DiscordNative", ...)` call and
  patches the real, single, pre-bridge object so the patch is visible
  everywhere, including to Discord's own webpack code. Surfaces results
  to the renderer half of this plugin via plain
  `window.dispatchEvent(CustomEvent)` (DOM events aren't subject to
  contextBridge cloning -- preload and the page share one DOM/window).
  Runs via Equicord core's generic per-plugin preload mechanism
  (`src/pluginPreloads.ts`), on the `preloadPlugins` branch of
  [this Equicord fork](https://github.com/pendo324/Equicord) -- not yet
  merged upstream (see the "Distribution status" section below), so
  this plugin needs that fork+branch until it lands.
- **This plugin's renderer half** (`index.tsx`): listens for those
  events, shows its own picker modal, and drives the actual PipeWire
  routing via [`patchcord`](https://github.com/pendo324/patchcord) (a
  native `libpipewire` helper, forked from
  [Milkshiift/patchcord](https://github.com/Milkshiift/patchcord) with a
  richer `RouteFilter`/multi-node `routeNodes` API this plugin depends
  on).

**Both halves are required.** This plugin alone does nothing without
Equicord core's generic per-plugin preload mechanism also being
present (see "Distribution status" below).

### Why not just make the virtual sink the system default?

Tried this first. It doesn't work: making a sink the system default
causes *every* app currently playing audio to follow it there too (that's
what "default sink" means to PipeWire/WirePlumber) -- confirmed live
during development, it defeats the entire point of app-only audio. This
plugin instead swaps Discord's own microphone input device to the
virtual mic for the duration of the share; the real system default sink
is never touched, so every other app keeps playing to the real speakers
completely unaffected.

## Setup

### 1. Equicord core patch (required)

This plugin depends on Equicord core changes (`emitPluginNativeEvent`
and the generic per-plugin `preload.ts` mechanism) that aren't merged
into upstream Equicord yet -- see "Distribution status" below for the current
status. Until they land, build Equicord from
[`pendo324/Equicord`](https://github.com/pendo324/Equicord), branch
`preloadPlugins`:

```sh
git clone https://github.com/pendo324/Equicord
cd Equicord
git checkout preloadPlugins
pnpm install
```

### 2. Add this plugin

Userplugins are gitignored by Equicord convention (which is why this
lives in a separate repo rather than being part of the Equicord fork
itself) -- copy it into your checkout manually:

```sh
git clone https://github.com/pendo324/patchcordAppAudio
mkdir -p src/userplugins
cp -r patchcordAppAudio src/userplugins/patchcordAppAudio
rm -rf src/userplugins/patchcordAppAudio/.git
```

### 3. `patchcord` binary

Downloaded and installed automatically the first time you enable the
plugin and try to use it -- Discord will prompt for your consent before
downloading or executing anything (per-asset, checksum-verified). No
manual build step needed.

If you'd rather build it yourself (e.g. to audit the source first),
clone [`pendo324/patchcord`](https://github.com/pendo324/patchcord),
build with `cargo build --release`, and place the resulting binary at
`~/.config/Equicord/patchcordAppAudio/patchcord-linux-$(uname -m | sed 's/x86_64/x64/')`
before enabling the plugin -- it will detect the existing file's
checksum and skip the download/consent prompt for that asset.

### 4. Build Equicord and inject it into Discord

This step turns your source checkout into an actual patch applied to
your installed Discord client. If you've never done this before, follow
it exactly.

**a. Build the JS/CSS bundle.** This compiles `src/` (including the
core patch from step 1 and the plugin from step 2) into `dist/desktop/`,
which is what actually gets injected -- nothing from the previous steps
takes effect until this runs:

```sh
cd Equicord
pnpm build
```

Takes a few seconds. You should see `dist/desktop/patcher.js`,
`renderer.js`, `preload.js`, etc. get written.

**b. Close Discord completely** if it's running. Injecting into a
running instance doesn't work -- quit it from the tray icon or
`killall Discord`, don't just close the window.

**c. Run the injector:**

```sh
pnpm inject
```

The first time you run this, it downloads Equicord's own installer tool
(`EquilotlCli`) automatically -- that's expected, a one-time download.
It then launches an **interactive terminal menu**:

- It auto-detects installed Discord clients (Stable/PTB/Canary/etc.) and
  lists them.
- Use arrow keys to select your Discord install, press Enter.
- It'll ask whether to install -- confirm yes.
- It patches Discord's `app.asar` to load your local `dist/desktop`
  build instead of the stock one. This is a live link, not a one-time
  copy: any time you `pnpm build` again later (e.g. after pulling plugin
  updates), just reopening Discord picks up the new build automatically
  -- no need to re-run `pnpm inject` unless you're switching which
  Discord install is patched.

If the menu doesn't show your Discord install, it's probably in a
nonstandard location -- the tool has a manual "custom install path"
option in the same menu.

**d. Open Discord normally.** You should see `Equicord` log lines in
Discord's DevTools console (`Ctrl+Shift+I`) on startup. The plugin will
be listed and toggleable under **Discord Settings > Equicord > Plugins >
PatchcordAppAudio**.

Linux native Discord only -- this plugin no-ops everywhere else
(`IS_DISCORD_DESKTOP && process.platform === "linux"` gate in
`start()`).

**To undo everything later:** `pnpm uninject` from the same `Equicord`
folder (same interactive menu) restores Discord to stock.

## Distribution status

The core changes this plugin depends on
(`emitPluginNativeEvent` -- a generic main-to-renderer push channel for
plugin natives -- and the generic per-plugin `preload.ts` mechanism,
`src/pluginPreloads.ts`) are written as two clean, generic,
plugin-agnostic commits with no PatchcordAppAudio-specific code in
Equicord core itself, specifically so they can be proposed upstream
independently of this plugin. They currently live only on
[`pendo324/Equicord`](https://github.com/pendo324/Equicord)'s
`preloadPlugins` branch; no PR is open against `Equicord/Equicord` yet.

Until that's merged (or a PR is at least open and reviewable), the
`git checkout preloadPlugins` step above is the only way to get this
plugin's preload half to work at all -- there's no way to make
`patchcordAppAudio` function against a stock, unmodified Equicord
install. If you want to help move this along, opening the PR upstream
(or bugging the maintainers to review one) is the actual unblock;
running the fork in the meantime is the correct stopgap, not a
workaround to route around indefinitely.

## Usage

Start a screenshare as normal. Once Discord's real native picker
(window/screen selection) completes, this plugin's own modal appears,
*blocking* Discord's actual stream start until you resolve it (or a 10
minute safety-timeout elapses, in case something goes wrong).

Three modes:

- **None** -- Discord's normal whole-system audio, unmodified.
- **Specific Apps** -- pick one or more apps from a multi-select list;
  only their audio is routed into the stream. If patchcord/KWin can
  correlate your shared window to a specific app, the list is
  pre-filtered to likely matches (with a link to show everything).
- **Entire System** -- share your whole system's default audio like
  Discord's own "Stream With Audio", except any apps you explicitly
  exclude in the list below.

**Advanced audio filters** (collapsed by default): Only Speakers, Only
Default Speakers, Ignore Inputs, Ignore Virtual, Ignore Devices, Device
Selection -- passed straight through to patchcord's `RouteFilter`, which
applies them server-side when resolving which nodes actually get routed
(see `patchcord`'s `state_native.rs::should_link`).

Hit **Refresh** in the modal header to re-scan audio sources without
closing it (useful if you open the picker before the app you want to
share has started making sound).

If **Remember last selection** is enabled (default on), your last pick
is pre-selected next time.

Discord's own "New Audio Device Detected" prompt is suppressed at the
source for patchcord's virtual mic (filtered out of the device list
before Discord's own detection logic ever sees it, in this plugin's own
`preload.ts`), and routing is torn down on the real "desktop source
ended" signal, not an approximated proxy.

## Architecture notes

- `native.ts` spawns `patchcord` and exposes `listShareableNodes`/
  `findScreencastHint`/`startAppAudio`/`stopAppAudio` to the renderer via
  the standard `pluginHelpers` request/response mechanism.
- `patchcordClient.js`/`.d.ts` are a vendored copy of patchcord's own
  `node/patchcord.js` client (Equicord has no npm dependency on
  `patchcord`, since it isn't published there).
- `startAppAudio` creates the virtual sink+mic pair (with `virtualMic:
  true`) and routes the target nodes' audio into it via patchcord's
  `routeNodes(nodeIds, filter)`, returning the virtual mic's device
  description string for the renderer to match against
  `enumerateDevices()`.
- The modal is built from Equicord's real `Modal`/`SearchableSelect`/
  `Checkbox` components (`@webpack/common`), which resolve to Discord's
  own internal component implementations via webpack -- not a hand-built
  DOM overlay -- so it gets Discord's actual modal chrome, animation,
  focus-trap, and theme/QuickCSS reactivity for free instead of
  approximating it with hardcoded CSS variable references.
