# Xpo UI integration notes

This private test branch applies the visual direction in the [Xpo Figma file](https://www.figma.com/design/Qt1lA1U6By5tHL3Fa5lstW/Xpo?node-id=62-3289&t=IYTaqi3BBZjpDMX4-1) to the existing Muverse application. The Figma file is the design reference; this repository contains the working application and its existing feature logic.

## What was carried over

- A compact MUVERSE identity and primary navigation for discovery, practice, and playlists.
- A landing hero with a clear search call to action, strong display typography, a dark stage-like panel, and bright lime accents.
- A calmer surface hierarchy for the active video, saved collections, watch history, and search results.
- A responsive layout that stacks the player and formation map on narrow screens.
- Consistent visual treatment for Random Dance status, playlist actions, highlight editing, formation calibration, and the playlist destination dialog.

The existing React components and state remain responsible for behavior: YouTube playback, highlight analysis/editing, formation analysis/calibration/editing, saved dancer names, playlists, and Random Dance. The presentation was changed around those interfaces instead of replacing their data flow.

## Known integration boundaries

- The Figma file includes more screens and product flows than the current application implements. This branch styles the current Muverse flows; screens requiring new product behavior are not represented as nonfunctional buttons.
- The current app stores playlists, analysis results, calibration, names, and watch history in browser `localStorage`. This test build does not add accounts or cross-device synchronization.
- Search and video playback still depend on the existing YouTube API configuration and YouTube embed availability. The local formation worker is still required for new formation analysis; previously saved browser results can be viewed without re-running that analysis.
- The visual integration is a working approximation of the selected Figma page and design system, not a pixel-perfect export of every Figma frame. Figma components/assets are not copied into the app.

## Source and third-party projects

The Figma design is used as a UI reference. No Figma source, assets, or code were imported. The formation workflow was informed by [GridStage](https://github.com/ChangShengHsun/GridStage); the project documentation describes what was independently implemented. Other upstream software and licensing notes are listed in the repository [README](../README.md).

## Verify locally

From the repository root, run:

```powershell
npm ci
npm run build
npm run dev
```

The app opens at `http://localhost:3100`. For formation analysis, start the Python worker as described in [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md). The production build checks compilation and TypeScript validity; YouTube playback and the local Python worker additionally need live configuration to exercise end to end.
