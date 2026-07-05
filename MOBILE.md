# Forcefield mobile builds (Capacitor)

The web app in `src/` is the single source of truth. Capacitor wraps the built
`dist/` in native iOS/Android shells; the Netlify web deploy is unaffected —
`npm run build` stays pure web, and mobile work happens through the
`mobile:*` scripts.

| Command | What it does |
|---|---|
| `npm run mobile:sync` | Build web assets + copy into both platforms (`cap sync`) |
| `npm run mobile:android` | Build + sync + open Android Studio |
| `npm run mobile:ios` | Build + sync + open Xcode (Mac only) |

`npx cap sync` must run after **any** web code change before a native build —
the copied assets under `android/app/src/main/assets/public/` and
`ios/App/App/public/` are gitignored, so a fresh clone has none until you sync.

- App ID: `com.forcefield.app` · App name: Forcefield · config: `capacitor.config.ts`
- Android uses the `https://localhost` scheme (`androidScheme: 'https'`) so
  secure-context web APIs behave identically to the Netlify deploy.

## Android (works on this Windows box)

1. Install Android Studio (bundles SDK + JDK).
2. `npm run mobile:android`
3. In Android Studio: pick a device/emulator → Run. For a store build:
   Build → Generate Signed App Bundle (create a keystore once, keep it safe —
   losing it means losing the Play Store listing).

## iOS (requires a Mac — the `ios/` folder is committed and ready)

Capacitor 8 uses Swift Package Manager (no CocoaPods). On the Mac:

1. Install Xcode 16+ from the App Store, then `xcode-select --install`.
2. Clone the repo, `npm ci`.
3. `npm run mobile:ios` (or `npx cap sync ios && npx cap open ios`).
4. First open: Xcode resolves the Capacitor SPM packages automatically
   (File → Packages → Resolve Package Versions if it doesn't).
5. Select the **App** target → Signing & Capabilities → set your Team
   (personal Apple ID works for device testing; App Store distribution needs
   the $99/yr Apple Developer Program).
6. Pick a simulator or plugged-in iPhone → Run.

## Release checklist (later)

- Icons/splash: replace placeholders via `@capacitor/assets` (one 1024×1024
  icon + 2732×2732 splash source, `npx capacitor-assets generate`).
- Android: versionCode/versionName in `android/app/build.gradle`.
- iOS: version/build in Xcode target settings; App Store Connect listing.
- Push notifications: see the scaffolding notes in this file once step 2 lands
  (FCM for Android, APNs key for iOS).
