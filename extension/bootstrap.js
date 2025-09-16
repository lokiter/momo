var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

function install() {}
function uninstall() {}

async function startup(data, reason) {
  try {
    if (!globalThis.Zotero) {
      await new Promise((resolve) => {
        Services.obs.addObserver({
          observe(subject, topic) {
            if (topic === "zotero-loaded") {
              Services.obs.removeObserver(this, "zotero-loaded");
              resolve();
            }
          },
        }, "zotero-loaded");
      });
    }
    await Zotero.initializationPromise;
    Services.scriptloader.loadSubScript(
      "chrome://zotero-obsidian-daily/content/obsidian.js",
      this
    );
    if (Zotero.ObsidianDaily) {
      await Zotero.ObsidianDaily.shutdown();
    }
    Zotero.ObsidianDaily = new Zotero.ObsidianDailyExporter();
    await Zotero.ObsidianDaily.startup();
  } catch (err) {
    Zotero.logError(err);
  }
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  try {
    if (Zotero?.ObsidianDaily) {
      await Zotero.ObsidianDaily.shutdown();
      delete Zotero.ObsidianDaily;
    }
  } catch (err) {
    Zotero.logError(err);
  }
}
