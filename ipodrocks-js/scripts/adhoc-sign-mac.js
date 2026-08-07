/**
 * electron-builder `afterSign` hook: ad-hoc sign and seal the macOS .app bundle.
 *
 * Without an Apple Developer ID, electron-builder SKIPS code signing, leaving the
 * bundle with no `Contents/_CodeSignature` seal. The main executable still carries
 * the linker's automatic ad-hoc signature, so its seal claims resources exist while
 * none are sealed -> Gatekeeper rejects the quarantined app as "damaged".
 *
 * Ad-hoc signing (identity "-") seals the whole bundle for free (no Apple account).
 * This removes the "damaged" error; users still get the normal one-time
 * "unidentified developer" gate (right-click -> Open) until the app is notarized.
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSignMac(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist");

  console.log(`[adhoc-sign] ad-hoc signing ${appPath}`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--timestamp=none", "--sign", "-", "--entitlements", entitlements, appPath],
    { stdio: "inherit" }
  );

  // Fail the build if the seal is somehow still invalid.
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  console.log("[adhoc-sign] bundle sealed and verified");
};
