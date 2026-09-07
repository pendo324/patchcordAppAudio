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
this plugin's own source comments (`index.tsx`, and Equicord core's
`discordNativePatch.ts`). Short version: under Wayland, native Discord's
desktop client does **not** use the standard Web `getDisplayMedia()` API
at all. It calls straight into a native N-API addon
(`discord_voice.node`) via `setNativeScreenSharePickerCallbacks`, which
talks directly to `BaseCapturerPipeWire` in C++ -- confirmed via `strings`
on the addon and extensive live testing; multiple earlier interception
attempts on `getDisplayMedia`/`setDesktopSourceWithOptions` were tried
and abandoned once this was understood.

Because of this, and because of an unrelated but equally important
Electron `contextBridge` quirk (`DiscordNative.nativeModules.
requireModule(name)` returns a **fresh structured-clone every call**, so
patching the native module from ordinary renderer code silently patches
nothing anyone else ever sees), the actual native-module patch lives in
Equicord core, not in this plugin:

- **Equicord core patch** (`src/discordNativePatch.ts` + `src/preload.ts`
  wiring, on the `patchcordAppAudio` branch of
  [this Equicord fork](https://github.com/pendo324/Equicord)): intercepts
  Discord's own `contextBridge.exposeInMainWorld("DiscordNative", ...)`
  call in the **preload** context, before contextBridge ever clones the
  native `discord_voice` module out. Patches the real, single, pre-bridge
  object so the patch is visible everywhere, including to Discord's own
  webpack code. Surfaces results to this plugin via plain
  `window.dispatchEvent(CustomEvent)` (DOM events aren't subject to
  contextBridge cloning -- preload and the page share one DOM/window).
- **This plugin** (renderer-side): listens for those events, shows its
  own picker modal, and drives the actual PipeWire routing via
  [`patchcord`](https://github.com/pendo324/patchcord) (a native
  `libpipewire` helper, forked from
  [Milkshiift/patchcord](https://github.com/Milkshiift/patchcord) with a
  richer `RouteFilter`/multi-node `routeNodes` API this plugin depends
  on).

**Both halves are required.** This plugin alone does nothing without the
Equicord core patch also being installed.

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

Build Equicord from
[`pendo324/Equicord`](https://github.com/pendo324/Equicord), branch
`patchcordAppAudio`:

```sh
git clone https://github.com/pendo324/Equicord
cd Equicord
git checkout patchcordAppAudio
pnpm install
```

### 2. This plugin

Copy this folder into `src/userplugins/patchcordAppAudio/` in that
Equicord checkout (userplugins are gitignored by Equicord convention,
which is why this lives in a separate repo rather than being part of the
Equicord fork itself).

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

### 4. Build and install Equicord

```sh
cd Equicord
pnpm build
```

Then inject into your Discord install per Equicord's normal dev-install
flow (`pnpm inject`, or set `EQUICORD_DEV_INSTALL`/`EQUICORD_DIRECTORY`
per Equicord's own docs). Linux native Discord only -- this plugin
no-ops everywhere else (`IS_DISCORD_DESKTOP && process.platform ===
"linux"` gate in `start()`).

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
before Discord's own detection logic ever sees it, in the Equicord core
patch), and routing is torn down on the real "desktop source ended"
signal, not an approximated proxy.

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
- The modal is a fully custom, DOM-only overlay (not a native `<select>`
  -- Electron's native `<select>` popup renders via a separate OS surface
  that doesn't compose inside Discord's frameless window, confirmed
  non-interactable live), styled using Discord's own CSS custom
  properties (`--background-primary` etc.) so it matches the user's
  actual theme automatically.
