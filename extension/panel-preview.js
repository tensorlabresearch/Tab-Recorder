if (window.location.protocol === "file:") {
  window.addEventListener("DOMContentLoaded", () => {
    const splash = document.getElementById("loading-splash");
    const status = document.getElementById("status");
    const folderName = document.getElementById("folder-name");
    const micSelect = document.getElementById("mic-select");
    const micSelectLive = document.getElementById("mic-select-live");
    const startButton = document.getElementById("start-btn");
    const pickFolderButton = document.getElementById("pick-folder-btn");
    const openFolderButton = document.getElementById("open-folder-btn");
    const refreshButton = document.getElementById("refresh-recordings-btn");

    for (const select of [micSelect, micSelectLive]) {
      if (!select || select.options.length) continue;
      const option = document.createElement("option");
      option.value = "__preview__";
      option.textContent = "Preview microphone";
      select.append(option);
    }

    if (folderName) folderName.textContent = "Preview mode";
    if (status) {
      status.textContent = "Preview mode: load the unpacked extension in Chrome to record audio.";
    }
    for (const button of [startButton, pickFolderButton, openFolderButton, refreshButton]) {
      if (button) button.disabled = true;
    }
    document.getElementById("open-settings-btn")?.addEventListener("click", () => {
      window.location.href = "settings.html";
    });
    document.getElementById("open-support-link")?.addEventListener("click", (event) => {
      event.preventDefault();
      window.location.href = "support.html";
    });
    splash?.classList.add("is-hidden");
  });
}
