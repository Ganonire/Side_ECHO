// ================================================================
// SIDE ECHO — main.js (ФИНАЛЬНЫЙ ФИКС ЛОГИКИ КОШКИ)
// ================================================================

runOnStartup((runtime) => {
  const LEGACY_SAVE_KEY = "side-echo-checkpoint-v1";
  const SAVE_KEY = "side-echo-checkpoint-json-v2";
  
  const SAVE_FILENAME = "savegame.json";
  const SAVE_PATH = SAVE_FILENAME;

  const DOCUMENTS_TAG = "<documents>";
  const PREVIEW_PICKER_TAG = "side-echo-documents";
  const HANDLE_DB = "side-echo-documents-permission-v2";
  const HANDLE_STORE = "directories";
  const HANDLE_ID = "documents-root";
  const SETTINGS_TYPES = [
    "endPanel",
    "settingsTitleText",
    "settingsInfoText",
    "settingsBackButton",
    "settingsPickSaveFolderButton",
  ];
  const GAME_LAYOUT = "Layout 1";
  const MENU_LAYOUT = "StartMenu";
  const VAR_NAMES = [
    "Energy",
    "roomSelect",
    "Credits",
    "CatFood",
    "CouriersArrived",
    "CouriersLost",
    "ZonesLost",
    "EchoTalks",
    "EnergySpent",
  ];

  let queuedStorage = Promise.resolve();
  let loadForNextGame = null;
  let cleanup = () => {};
  let configPromise = null;
  let projectRootHandle = null;
  let saveFolderProblem = "";
  let newGameSaveWarning = "";

  function createSettingsController({
    beforeOpen = () => true,
    afterClose = () => {},
  } = {}) {
    const layer = runtime.layout.getLayer("Options");
    const parts = SETTINGS_TYPES.flatMap((name) =>
      (runtime.objects[name]?.getAllInstances() ?? []).filter(
        (o) => o.layer === layer,
      ),
    );
    const back = runtime.objects.settingsBackButton?.getFirstInstance();
    let opened = false;
    parts.forEach((o) => { o.isVisible = false; });
    function open() {
      if (opened || beforeOpen() === false) return;
      opened = true;
      parts.forEach((o) => { o.isVisible = true; });
    }
    function close() {
      if (!opened) return;
      opened = false;
      parts.forEach((o) => { o.isVisible = false; });
      afterClose();
    }
    back?.addEventListener("click", close);
    return { open, close };
  }

  function loadGameConfig() {
    if (!configPromise) {
      configPromise = runtime.assets
        .getProjectFileUrl("tik.json")
        .then((url) => fetch(url))
        .then((response) => response.json())
        .catch((e) => {
          return { settings: {} };
        });
    }
    return configPromise;
  }

  function storageOperation(action) {
    queuedStorage = queuedStorage.catch(() => {}).then(action);
    return queuedStorage;
  }

  const fsPlugin = runtime.objects.FileSystem;
  function hasDesktopDocuments() {
    return (
      !!fsPlugin?.desktopFeaturesSupported &&
      typeof fsPlugin.hasPickerTag === "function" &&
      fsPlugin.hasPickerTag(DOCUMENTS_TAG)
    );
  }
  function hasPluginPreviewDocuments() {
    return (
      !!fsPlugin?.isSupported &&
      typeof fsPlugin.showFolderPicker === "function" &&
      typeof fsPlugin.hasPickerTag === "function"
    );
  }
  function getNativeSaveTag() {
    if (hasDesktopDocuments()) return DOCUMENTS_TAG;
    if (fsPlugin?.hasPickerTag?.(PREVIEW_PICKER_TAG)) return PREVIEW_PICKER_TAG;
    return null;
  }
  function supportsPreviewDocuments() {
    return (
      hasPluginPreviewDocuments() ||
      (!runtime.isInWorker &&
        typeof window !== "undefined" &&
        typeof window.showDirectoryPicker === "function" &&
        typeof indexedDB !== "undefined")
    );
  }

  function openHandleDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(HANDLE_DB, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(HANDLE_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function getRememberedDocuments() {
    if (!supportsPreviewDocuments()) return null;
    const db = await openHandleDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction(HANDLE_STORE, "readonly")
          .objectStore(HANDLE_STORE)
          .get(HANDLE_ID);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }
  async function rememberDocuments(handle) {
    const db = await openHandleDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(handle, HANDLE_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  async function hasDocumentsPermission(mode = "read") {
    if (hasDesktopDocuments()) return true;
    if (!projectRootHandle) return false;
    try {
      if (typeof projectRootHandle.queryPermission !== "function") return true;
      return (await projectRootHandle.queryPermission({ mode })) === "granted";
    } catch (e) {
      return false;
    }
  }

  function requestDocumentsFromClick({ forcePicker = false } = {}) {
    if (hasDesktopDocuments()) return Promise.resolve(true);
    if (hasPluginPreviewDocuments()) {
      if (!forcePicker && fsPlugin.hasPickerTag(PREVIEW_PICKER_TAG))
        return Promise.resolve(true);
      try {
        return fsPlugin
          .showFolderPicker({
            pickerTag: PREVIEW_PICKER_TAG,
            mode: "readwrite",
            id: "side-echo-documents",
            startIn: "documents",
          })
          .then(() => {
            saveFolderProblem = "";
            return true;
          });
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (!supportsPreviewDocuments())
      return Promise.reject(new Error("Нет доступа к папке"));
    let requested;
    try {
      if (
        !forcePicker &&
        projectRootHandle &&
        typeof projectRootHandle.requestPermission === "function"
      ) {
        requested = projectRootHandle
          .requestPermission({ mode: "readwrite" })
          .then((state) => {
            if (state !== "granted") throw new Error("Доступ не разрешён");
            return projectRootHandle;
          });
      } else if (!forcePicker && projectRootHandle) {
        requested = Promise.resolve(projectRootHandle);
      } else {
        requested = window.showDirectoryPicker({
          id: "side-echo-documents",
          startIn: "documents",
          mode: "readwrite",
        });
      }
    } catch (e) {
      return Promise.reject(e);
    }
    return requested.then(async (handle) => {
      projectRootHandle = handle;
      try {
        await rememberDocuments(handle);
      } catch (e) {}
      saveFolderProblem = "";
      return handle;
    });
  }

  async function getPreviewSaveHandle(create = false) {
    if (!projectRootHandle) return null;
    if (!(await hasDocumentsPermission(create ? "readwrite" : "read")))
      throw new Error("Разреши доступ к папке");
    try {
      return await projectRootHandle.getFileHandle(SAVE_FILENAME, { create });
    } catch (e) {
      if (!create && e?.name === "NotFoundError") return null;
      throw e;
    }
  }
  
  function parseSave(raw) {
    if (!raw) return null;
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return (data?.version === 1 || data?.version === 2) &&
        data?.variables &&
        typeof data.variables.Energy === "number"
        ? data
        : null;
    } catch (e) {
      return null;
    }
  }
  function isMissingFileError(e) {
    return (
      e?.name === "NotFoundError" ||
      e?.code === "ENOENT" ||
      /not found|no such file|не найден|cannot find the (?:path|file)/i.test(
        e?.message || "",
      )
    );
  }
  
  async function getNativeSaveFolderState(pickerTag) {
    const root = await fsPlugin.listContent(pickerTag, "", false);
    return {
      folderExists: true, 
      fileExists: root.files.includes(SAVE_FILENAME),
    };
  }
  
  async function readCheckpoint() {
    try {
      let content;
      const nativeTag = getNativeSaveTag();
      if (nativeTag) {
        const state = await getNativeSaveFolderState(nativeTag);
        if (!state.fileExists) return null;
        content = await fsPlugin.readFile({
          pickerTag: nativeTag,
          folderPath: SAVE_FILENAME,
          mode: "text",
        });
      } else {
        const handle = await getPreviewSaveHandle(false);
        if (!handle) return null;
        content = await (await handle.getFile()).text();
      }
      const parsed = parseSave(content);
      if (!parsed) throw new Error("Файл повреждён");
      saveFolderProblem = "";
      return parsed;
    } catch (e) {
      if (!isMissingFileError(e)) saveFolderProblem = e.message || String(e);
      return null;
    }
  }

  async function writeCheckpoint(data) {
    const contents = JSON.stringify(data, null, 2) + "\n";
    const nativeTag = getNativeSaveTag();
    if (nativeTag) {
      await fsPlugin.writeFile({
        pickerTag: nativeTag,
        folderPath: SAVE_FILENAME,
        mode: "overwrite",
        data: contents,
      });
    } else {
      const handle = await getPreviewSaveHandle(true);
      if (!handle) throw new Error("Разреши доступ к папке");
      const writer = await handle.createWritable({ keepExistingData: false });
      try {
        await writer.write(contents);
        await writer.close();
      } catch (e) {
        try {
          await writer.abort();
        } catch (_) {}
        throw e;
      }
    }
    const savedOnDisk = await readCheckpoint();
    if (!savedOnDisk) throw new Error("Файл не сохранился");
    try {
      await runtime.storage.setItem(SAVE_KEY, contents);
    } catch (e) {}
  }

  async function deleteCheckpoint() {
    const nativeTag = getNativeSaveTag();
    if (nativeTag) {
      const state = await getNativeSaveFolderState(nativeTag);
      if (state.fileExists) await fsPlugin.delete(nativeTag, SAVE_FILENAME, false);
    } else {
      const handle = await getPreviewSaveHandle(false);
      if (handle) {
        if (!(await hasDocumentsPermission("readwrite")))
          throw new Error("Нет прав");
        try {
          await projectRootHandle.removeEntry(SAVE_FILENAME);
        } catch (e) {
          if (!isMissingFileError(e)) throw e;
        }
      }
    }
    await runtime.storage.removeItem(SAVE_KEY);
    await runtime.storage.removeItem(LEGACY_SAVE_KEY);
  }

  async function initStartMenu() {
    const get = (name) => runtime.objects[name]?.getFirstInstance() ?? null;
    const newButton = get("menuNewGameButton");
    const continueButton = get("menuContinueButton");
    const settingsButton = get("menuSettingsButton");
    const loreButton = get("menuLoreButton");
    const exitButton = get("menuExitButton");
    const folderButton = get("settingsPickSaveFolderButton");
    const infoText = get("settingsInfoText");
    const titleText = get("menuTitleText");

    let checkpoint = null;
    let opening = false;

    if (continueButton) continueButton.isEnabled = false;
    if (settingsButton) settingsButton.isEnabled = true;
    if (newButton) newButton.isEnabled = true;
    if (loreButton) loreButton.isEnabled = true;
    if (exitButton) exitButton.isEnabled = true;

    const menuButtons = [
      newButton,
      continueButton,
      settingsButton,
      loreButton,
      exitButton,
      titleText,
    ].filter(Boolean);

    let settingsUI;
    try {
      settingsUI = createSettingsController({
        beforeOpen: () => {
          menuButtons.forEach((o) => (o.isVisible = false));
          return true;
        },
        afterClose: () => {
          menuButtons.forEach((o) => (o.isVisible = true));
        },
      });
    } catch (e) {
      console.error("SIDE ECHO: не удалось создать окно настроек", e);
      settingsUI = { open: () => {
        if (titleText) titleText.text = "ОШИБКА ОКНА НАСТРОЕК";
      }, close: () => {} };
    }

    async function updateFolderInfo() {
      if (!infoText) return;
      if (hasDesktopDocuments()) {
        infoText.text = `СОХРАНЕНИЯ:\n${SAVE_FILENAME}`;
        if (folderButton) {
          folderButton.isEnabled = false;
          folderButton.isVisible = false;
        }
      } else if (!supportsPreviewDocuments()) {
        infoText.text = "Запись в папку недоступна в этом режиме.";
        if (folderButton) folderButton.isEnabled = false;
      } else if (
        getNativeSaveTag() === PREVIEW_PICKER_TAG ||
        (await hasDocumentsPermission())
      ) {
        infoText.text = `ПАПКА ПОДКЛЮЧЕНА\n${SAVE_FILENAME}`;
        if (folderButton) folderButton.isEnabled = true;
      } else {
        infoText.text = "В Preview один раз выбери папку для сохранений.";
        if (folderButton) folderButton.isEnabled = true;
      }
      if (saveFolderProblem) infoText.text += `\n${saveFolderProblem}`;
    }

    async function refreshCheckpoint() {
      try {
        checkpoint = await readCheckpoint();
      } catch (e) {
        checkpoint = null;
        console.warn("SIDE ECHO: не удалось прочитать сохранение", e);
      }
      if (continueButton) continueButton.isEnabled = !!checkpoint;
      await updateFolderInfo();
    }

    settingsButton?.addEventListener("click", () => {
      if (opening) return;
      settingsUI.open();
      if (hasDesktopDocuments() && folderButton) folderButton.isVisible = false;
      void updateFolderInfo().catch((e) => console.warn("SIDE ECHO: настройки папки", e));
    });

    folderButton?.addEventListener("click", () => {
      if (hasDesktopDocuments()) return;
      void requestDocumentsFromClick({ forcePicker: !projectRootHandle })
        .then(async () => {
          saveFolderProblem = "";
          await refreshCheckpoint();
        })
        .catch(async (e) => {
          saveFolderProblem = e?.message || String(e);
          await updateFolderInfo();
        });
    });

    const menuEscape = (e) => {
      if (e.key === "Escape") settingsUI.close();
    };
    runtime.addEventListener("keydown", menuEscape);
    cleanup = () => runtime.removeEventListener("keydown", menuEscape);

    newButton?.addEventListener("click", () => {
      if (opening) return;
      opening = true;
      if (newButton) newButton.isEnabled = false;
      if (continueButton) continueButton.isEnabled = false;
      newGameSaveWarning = "";

      void (async () => {
        try {
          await requestDocumentsFromClick();
        } catch (e) {
          saveFolderProblem = e?.message || String(e);
        }
        try {
          await storageOperation(deleteCheckpoint);
        } catch (e) {
          newGameSaveWarning = "НЕ УДАЛОСЬ ОЧИСТИТЬ СОХРАНЕНИЕ";
        }
        loadForNextGame = null;
        runtime.goToLayout(GAME_LAYOUT);
      })().catch((e) => {
        console.error("SIDE ECHO: ошибка запуска новой игры", e);
        opening = false;
        if (newButton) newButton.isEnabled = true;
        if (titleText) titleText.text = "НЕ УДАЛОСЬ ЗАПУСТИТЬ ИГРУ";
      });
    });

    continueButton?.addEventListener("click", () => {
      if (opening || !continueButton.isEnabled) return;
      opening = true;
      if (newButton) newButton.isEnabled = false;
      continueButton.isEnabled = false;
      void storageOperation(readCheckpoint)
        .then((saved) => {
          if (!saved) throw new Error("Файл сохранения не найден");
          loadForNextGame = saved;
          runtime.goToLayout(GAME_LAYOUT);
        })
        .catch(async (e) => {
          saveFolderProblem = e?.message || String(e);
          opening = false;
          if (newButton) newButton.isEnabled = true;
          await refreshCheckpoint();
        });
    });

    loreButton?.addEventListener("click", () => {
      if (titleText) titleText.text = "ИСТОРИЯ И АВТОРЫ — РАЗДЕЛ ПОКА НЕ ЗАПОЛНЕН";
    });

    exitButton?.addEventListener("click", () => {
      if (titleText) titleText.text = "ЧТОБЫ ВЫЙТИ, ЗАКРОЙТЕ ВКЛАДКУ ИГРЫ";
    });

    void (async () => {
      await queuedStorage.catch(() => {});
      if (
        !hasDesktopDocuments() &&
        !hasPluginPreviewDocuments() &&
        typeof indexedDB !== "undefined"
      ) {
        try {
          projectRootHandle = await getRememberedDocuments();
        } catch (e) {
          console.warn("SIDE ECHO: не удалось восстановить папку сохранений", e);
        }
      }
      await refreshCheckpoint();
    })().catch((e) => {
      console.error("SIDE ECHO: фоновая инициализация меню", e);
      if (continueButton) continueButton.isEnabled = false;
      if (infoText) infoText.text = "Не удалось проверить сохранение. Новая игра доступна.";
    });
  }

  runtime.addEventListener("beforeanylayoutend", () => {
    cleanup();
    cleanup = () => {};
  });

  runtime.addEventListener("beforeanylayoutstart", async ({ layout }) => {
    if (layout.name !== MENU_LAYOUT && layout.name !== GAME_LAYOUT) return;
    if (layout.name === MENU_LAYOUT) {
      await initStartMenu();
      return;
    }
    const restoredSave = loadForNextGame;
    loadForNextGame = null;
    const runtimeListeners = [];
    const onRuntime = (name, cb) => {
      runtime.addEventListener(name, cb);
      runtimeListeners.push([name, cb]);
    };

    const getOne = (name) => runtime.objects[name]?.getFirstInstance() ?? null;
    const getAll = (name) => runtime.objects[name]?.getAllInstances() ?? [];

    const config = await loadGameConfig();
    const varManager = runtime.objects.varManager.getFirstInstance();

    // Сброс переменных для новой игры
    if (!restoredSave) {
      varManager.instVars.Energy = config.settings?.maxEnergy || 10;
      varManager.instVars.Credits = 5; 
      varManager.instVars.CatFood = 0;
      varManager.instVars.CouriersArrived = 0;
      varManager.instVars.CouriersLost = 0;
      varManager.instVars.ZonesLost = 0;
      varManager.instVars.EchoTalks = 0;
      varManager.instVars.EnergySpent = 0;
    } else {
      for (const name of VAR_NAMES) {
        if (Object.hasOwn(restoredSave.variables, name)) {
          varManager.instVars[name] = restoredSave.variables[name];
        }
      }
    }
    
    runtime.globalVars.isTransitioning = 0;
    runtime.globalVars.shopOpen = 0;
    runtime.globalVars.roomSelect = restoredSave?.roomSelect === 1 ? 1 : 0;

    const energyText = getOne("energyText");
    const energyBar = getOne("energyBar");
    const energyBarBG = getOne("energyBarBg");
    const energyButtons = [
      getOne("energyButton"),
      getOne("energyButton2"),
      getOne("energyButton3"),
    ].filter(Boolean);
    const coffeeButton = getOne("coffeeButton");
    const dialogText = getOne("dialogText");
    const dialogTabRadio = getOne("dialogTabRadio");
    const dialogTabDevices = getOne("dialogTabDevices");
    const dialogTabMail = getOne("dialogTabMail");
    const askButton = getOne("askButton");
    const transferButton = getOne("transferButton");
    const declineButton = getOne("declineButton");
    const radioButtons = [askButton, transferButton, declineButton].filter(Boolean);
    const questionItems = getAll("questionItemText").sort((a, b) => a.y - b.y);
    const cameraObj = getOne("cameraObj");
    if (cameraObj)
      cameraObj.x = runtime.globalVars.roomSelect === 1 ? 2905 : 935;

    const hintButton = getOne("hintButton");
    const settingsButton = getOne("settingsButton");
    const saveNoticeText = getOne("saveNoticeText");
    if (saveNoticeText) saveNoticeText.isVisible = false;
    let saveNoticeExpires = 0;
    const hintCloseButton = getOne("hintCloseButton");
    const endMenuButton = getOne("endMenuButton");
    const endTempButton = getOne("endTempButton");
    const energySegments = getAll("energySegment").sort((a, b) => a.x - b.x);
    const changeFrameButton = getOne("changeFrameButton");
    const shopButton = getOne("shopButton");
    const catFace = getOne("catFace");

    const MAX_ENERGY = 10;
    const CURRENCY_LABEL = "ТАЛОНЫ";
    const COFFEE_PRICE = 3;
    const COFFEE_RESTORE = 3;
    const CATFOOD_PRICE = 2;
    const CATFOOD_MAX = 5;
    const energyCosts = [1, 1, 1];

    let isGameOver = false;
    let isShopDisabled = restoredSave?.isShopDisabled === true;
    let isTutorialPhase = !restoredSave && !isShopDisabled;

    // НОВЫЙ ФЛАГ: Был ли куплен корм хоть раз
    let hasBoughtCatFood = restoredSave?.hasBoughtCatFood !== undefined 
        ? restoredSave.hasBoughtCatFood 
        : (restoredSave?.isCatFed || false);

    // Инициализация кадра кошки
    let catState = 0;
    if (hasBoughtCatFood) {
        catState = (restoredSave?.catState === 2) ? 2 : 1;
    }

    let catAngryTimer = restoredSave?.catAngryTimer || 0;
    let echoMistakes = restoredSave?.echoMistakes || 0;

    const devicesUsed = restoredSave?.devicesUsed || [false, false, false];
    const chatHistory = restoredSave?.chatHistory || [];
    const deviceChatHistory = restoredSave?.deviceChatHistory || [];
    let callNumber = Number.isInteger(restoredSave?.callNumber) && restoredSave.callNumber >= 1 ? restoredSave.callNumber : 1;

    let shiftPersons = restoredSave?.shiftPersons;
    if (!shiftPersons) {
      const shuffled = [...(config.persons || [])].sort(() => 0.5 - Math.random());
      shiftPersons = shuffled.slice(0, 3);
      if (!shiftPersons.some((p) => p.isEcho)) {
        const echoPerson = config.persons.find((p) => p.isEcho);
        if (echoPerson) shiftPersons[0] = echoPerson;
      }
    }

    let currentPerson = restoredSave?.currentPerson || shiftPersons[0] || null;
    let currentSpeaker = currentPerson && currentPerson.isEcho && currentPerson.echo_value ? currentPerson.echo_value : currentPerson;

    const DEVICE_NAMES = ["Анализатор шума", "Анализатор голоса", "Радар погоды"];
    const callText = () => currentSpeaker && currentSpeaker.frequency ? `Частота: ${currentSpeaker.frequency} МГц` : `Звонок Nº ${callNumber}`;

    if (isShopDisabled && shopButton) shopButton.isVisible = false;

    let lastDisplayedEnergy = NaN;
    let lastDisplayedCredits = NaN;
    let creditsFlashTimer = null;
    const creditsTexts = getAll("creditsText").concat(getAll("shopCreditsText"));
    const creditsBaseColor = new Map();
    creditsTexts.forEach((t) => creditsBaseColor.set(t, [...t.colorRgb]));

    function updateEnergyUI() {
      const energy = varManager.instVars.Energy;
      if (energy === lastDisplayedEnergy) return;
      lastDisplayedEnergy = energy;
      if (energyText) energyText.text = String(energy);
      const ratio = Math.max(0, Math.min(1, energy / MAX_ENERGY));
      if (energySegments.length > 0) {
        const litCount = Math.round(ratio * energySegments.length);
        energySegments.forEach((seg, i) => { seg.isVisible = i < litCount; });
        if (energyBar) energyBar.isVisible = false;
        if (energyBarBG) energyBarBG.isVisible = true;
      } else if (energyBar) {
        energyBar.isVisible = ratio > 0;
      }
      const isOutOfEnergy = energy <= 0;
      energyButtons.forEach((btn, idx) => { btn.opacity = isOutOfEnergy || devicesUsed[idx] ? 0.2 : 1.0; });
    }

    function updateCreditsUI() {
      const credits = varManager.instVars.Credits;
      if (credits === lastDisplayedCredits) return;
      const previous = lastDisplayedCredits;
      lastDisplayedCredits = credits;
      const label = `${CURRENCY_LABEL}: ${credits}`;
      creditsTexts.forEach((t) => { if (t.text !== label) t.text = label; });
      if (!Number.isNaN(previous)) {
        const flash = credits > previous ? [0.4, 1, 0.5] : [1, 0.4, 0.4];
        creditsTexts.forEach((t) => { t.colorRgb = flash; });
        clearTimeout(creditsFlashTimer);
        creditsFlashTimer = setTimeout(() => {
          creditsTexts.forEach((t) => { t.colorRgb = creditsBaseColor.get(t); });
        }, 400);
      }
    }

    // ЛОГИКА ОТОБРАЖЕНИЯ КОШКИ
    function updateCatUI() {
      if (!catFace) return;
      
      // Если корм не покупали — намертво 0 кадр
      if (!hasBoughtCatFood) {
          catState = 0;
      } 
      // Если покупали — никогда не даем упасть в 0 (только 1 или 2)
      else if (catState === 0) {
          catState = 1; 
      }
      
      // ФИКС: Обязательно останавливаем анимацию, чтобы кадры не крутились сами по себе
      catFace.animationSpeed = 0;
      catFace.stopAnimation();
      
      catFace.animationFrame = catState;
      
      // ФИКС: Скрываем кошку, если открыт магазин или какой-то оверлей
      catFace.isVisible = (runtime.globalVars.shopOpen !== 1) && !overlay;
      
      const view = viewRect(catFace.layer);
      catFace.x = view.cx + view.w / 2 - 150;
      catFace.y = view.cy + view.h / 2 - 150;
    }

    let dialogTab = restoredSave?.dialog?.tab || "radio";
    let currentDevice = Number.isInteger(restoredSave?.dialog?.device) ? restoredSave.dialog.device : null;

    function generatePhrase(categoryKey) {
      if (!config.answers || !config.answers[categoryKey]) return "...";
      let pool = config.answers[categoryKey];
      if (!Array.isArray(pool) || pool.length === 0) return "...";
      const template = pool[Math.floor(Math.random() * pool.length)];
      if (!currentSpeaker) return template;
      return template
        .replace(/{name}/g, currentSpeaker.name || "")
        .replace(/{cargo}/g, currentSpeaker.cargo || "")
        .replace(/{code_phrase}/g, currentSpeaker.code_phrase || "")
        .replace(/{weather}/g, currentSpeaker.weather || "")
        .replace(/{biome}/g, currentSpeaker.biome || "")
        .replace(/{route_start}/g, currentSpeaker.route?.start || "")
        .replace(/{route_end}/g, currentSpeaker.route?.end || "");
    }

    function renderDialog() {
      const radioMode = dialogTab === "radio";
      const questionsMode = dialogTab === "questions";
      const deviceMode = dialogTab === "devices";
      const mailMode = dialogTab === "mail";
      
      if (dialogTabRadio) dialogTabRadio.animationFrame = radioMode || questionsMode ? 1 : 0;
      if (dialogTabDevices) dialogTabDevices.animationFrame = deviceMode ? 1 : 0;
      if (dialogTabMail) dialogTabMail.animationFrame = mailMode ? 1 : 0;
      
      radioButtons.forEach((b) => { b.isVisible = radioMode || questionsMode; });
      renderQuestions();
      
      if (!dialogText) return;
      if (questionsMode) {
        dialogText.isVisible = false;
        return;
      } else {
        dialogText.isVisible = true;
      }

      if (radioMode) {
        const visibleHistory = chatHistory.slice(-6);
        dialogText.text = visibleHistory.length > 0 ? visibleHistory.join("\n\n") : callText();
      } else if (mailMode) {
        let faxText = `[color=#84e6a6][b]СПИСОК ОЖИДАЕМЫХ КУРЬЕРОВ:[/b][/color]\n\n`;
        shiftPersons.forEach((p, idx) => {
          faxText += `${idx + 1}. [color=#84e6a6]${p.name}[/color] (${p.frequency || "??"} МГц) - ${p.cargo}\n`;
          faxText += `   [color=#aaaaaa]Кодовое слово: ${p.code_phrase || "??"}[/color]\n\n`;
        });
        dialogText.text = faxText;
      } else {
        const visibleDeviceHistory = deviceChatHistory.slice(-4);
        dialogText.text = visibleDeviceHistory.length > 0 ? visibleDeviceHistory.join("\n\n") : "Выберите прибор для анализа.";
      }
    }

    const questions = (Array.isArray(config.questions) && config.questions.length ? config.questions : ["Кодовая фраза?", "Груз?", "Погода?", "Местность?"]).slice(0, questionItems.length);
    const questionsAsked = questions.map((_, i) => restoredSave?.questionsAsked?.[i] === true);
    let hoveredQuestion = -1;
    
    questionItems.forEach((item) => {
      if ("isBbcodeEnabled" in item) item.isBbcodeEnabled = true;
    });

    function renderQuestions() {
      const open = dialogTab === "questions";
      questionItems.forEach((item, i) => {
        const exists = i < questions.length;
        item.isVisible = open && exists;
        if (!exists) return;
        if (questionsAsked[i]) {
          item.colorRgb = [0.5, 0.5, 0.5];
          item.text = `[s]${questions[i]}[/s]`;
        } else {
          item.colorRgb = [1, 1, 1];
          item.text = hoveredQuestion === i ? `[u]${questions[i]}[/u]` : questions[i];
        }
      });
    }

    function questionAt(clientX, clientY) {
      if (dialogTab !== "questions") return -1;
      return questionItems.findIndex((item, i) => i < questions.length && isPointerOver(item, clientX, clientY));
    }

    function askQuestion(i) {
      if (i < 0 || questionsAsked[i] || varManager.instVars.Energy <= 0) return;
      varManager.instVars.Energy -= 1;
      varManager.instVars.EnergySpent += 1;
      updateEnergyUI();
      questionsAsked[i] = true;
      
      const categories = ["code_phrase", "cargo", "weather", "biome"];
      const category = categories[i];
      const answer = generatePhrase(category);
      
      chatHistory.push(`[color=#aaaaaa]> ${questions[i]}[/color]`);
      chatHistory.push(`[color=#84e6a6][b]${currentSpeaker.name}:[/b][/color]\n${answer}`);
      
      dialogTab = "radio";
      renderQuestions();
      renderDialog();
      
      if (varManager.instVars.Energy <= 0) {
        isGameOver = true;
        setTimeout(() => {
          if (dialogText) dialogText.text = "ЭНЕРГИЯ ИСЧЕРПАНА. СВЯЗЬ ПРЕРВАНА...";
          openEndScreen();
        }, 600);
      }
      void saveCheckpoint("action");
    }

    function resetQuestions() {
      questionsAsked.fill(false);
      hoveredQuestion = -1;
      renderQuestions();
    }

    function startNextCall() {
      if (callNumber >= 3) {
        isGameOver = true;
        openEndScreen();
        return;
      }
      
      checklistHistory[String(callNumber)] = listMarks.slice();
      callNumber += 1;
      resetQuestions();
      
      for (let i = 0; i < listMarks.length; i++) listMarks[i] = 0;
      for (let i = 0; i < devicesUsed.length; i++) devicesUsed[i] = false;
      deviceChatHistory.length = 0;

      renderListChecks();
      currentDevice = null;
      dialogTab = "radio";
      hoveredQuestion = -1;

      if (shiftPersons.length > 0) {
        const personIndex = (callNumber - 1) % shiftPersons.length;
        currentPerson = shiftPersons[personIndex];
        currentSpeaker = currentPerson.isEcho && currentPerson.echo_value ? currentPerson.echo_value : currentPerson;
        if (currentPerson.isEcho) varManager.instVars.EchoTalks += 1;
      }

      chatHistory.length = 0;
      chatHistory.push(`[color=#aaaaaa][i]${callText()}[/i][/color]`);
      if (currentSpeaker) {
        chatHistory.push(`[color=#84e6a6][b]${currentSpeaker.name}:[/b][/color]\n${generatePhrase("greetings")}`);
      }
      renderDialog();

      echoMistakes = 0;
      
      // Обновляем кошку на новый звонок
      if (hasBoughtCatFood) {
          catState = 1;
      } else {
          catState = 0;
      }
      updateCatUI();
      
      void saveCheckpoint("new-call");
    }

    function showDevice(index) {
      currentDevice = index;
      dialogTab = "devices";
      let deviceText = "";
      const realPerson = currentPerson;
      const analyzer = realPerson.analyzer || {};

      if (index === 0) {
        let sounds = [];
        if (analyzer.precipitation) sounds.push(`Осадки: ${analyzer.precipitation}`);
        if (analyzer.wind) sounds.push(`Ветер: ${analyzer.wind}`);
        if (analyzer.engine) sounds.push(`Двигатель: ${analyzer.engine}`);
        if (analyzer.other_sounds) sounds.push(`Фон: ${analyzer.other_sounds}`);
        deviceText = sounds.length > 0 ? sounds.join(".\n") : "Фоновый шум не распознан.";
      } else if (index === 1) {
        deviceText = realPerson.isEcho ? generatePhrase("voice_analysis_echo") : generatePhrase("voice_analysis_man");
      } else if (index === 2) {
        const realWeather = realPerson.weather ? realPerson.weather.toLowerCase() : "";
        deviceText = `Радар показывает: ${realWeather} в районе конечного пункта.`;
      }

      deviceChatHistory.push(`[color=#84e6a6][b]${DEVICE_NAMES[index]}:[/b][/color]\n${deviceText}`);
      renderDialog();
      void saveCheckpoint("action");
    }

    // --- МАГАЗИН ---
    const shopCloseButton = getOne("shopCloseButton");
    const shopCoffeeBuyButton = getOne("shopCoffeeBuyButton");
    const shopCatFoodBuyButton = getOne("shopCatFoodBuyButton");
    const shopCoffeeText = getOne("shopCoffeeText");
    const shopCatFoodText = getOne("shopCatFoodText");
    const shopMessageText = getOne("shopMessageText");
    
    const SHOP_PART_NAMES = [
      "shopPanel", "shopTitleText", "shopCreditsText", "shopMessageText",
      "shopCoffeeText", "shopCatFoodText", "shopCloseButton", "shopCoffeeBuyButton", "shopCatFoodBuyButton",
    ];
    const shopParts = SHOP_PART_NAMES.flatMap(getAll);

    let coffeeInStock = (typeof restoredSave?.inventory?.coffeeInStock === "boolean" ? restoredSave.inventory.coffeeInStock : restoredSave?.coffeeInStock) === true;
    let messageTimer = null;

    function showShopMessage(text) {
      if (!shopMessageText) return;
      shopMessageText.text = text;
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => { shopMessageText.text = ""; }, 1800);
    }
    function refreshShopTexts() {
      if (shopCoffeeText) shopCoffeeText.text = `Кофе (цена: ${COFFEE_PRICE})${coffeeInStock ? " — куплен" : ""}\nВосстанавливает 3 энергии`;
      if (shopCatFoodText) shopCatFoodText.text = `Кошачий корм (цена: ${CATFOOD_PRICE})\nЗапас: ${varManager.instVars.CatFood}/${CATFOOD_MAX}`;
    }

    const endText = {
      title: "ИТОГИ СМЕНЫ",
      arrived: "Курьеров дошло",
      lost: "Курьеров потеряно",
      zonesLost: "Зон потеряно",
      echoTalks: "Разговоров с Эхо",
      energySpent: "Энергии потрачено",
    };
    
    const endFields = [
      ["endArrivedText", endText.arrived, "CouriersArrived"],
      ["endLostText", endText.lost, "CouriersLost"],
      ["endZonesText", endText.zonesLost, "ZonesLost"],
      ["endEchoText", endText.echoTalks, "EchoTalks"],
      ["endEnergyText", endText.energySpent, "EnergySpent"],
    ].map(([name, label, varName]) => ({ obj: getOne(name), label, varName }));
    const endTitleText = getOne("endTitleText");

    const hintParts = ["hintPanel", "hintText", "hintCloseButton"].flatMap(getAll);
    const hintTextObject = getOne("hintText");
    
    const HINT_MEMO_TEXT = `ПАМЯТКА ОПЕРАТОРА «МАЯКА»
Перед началом смены ознакомьтесь с порядком работы!

1. Подготовьтесь к смене
- В начале игры вам доступен магазин. Вы можете приобрести необходимые товары: кофе и корм для кошки.
- Магазин будет доступен только в начале игры. После его закрытия сделать новые покупки не получится: поставки на «Маяк» осуществляются только один раз за смену.
- Распределите имеющиеся ресурсы разумно — пополнить запасы позже не удастся.

2. Получите сигнал
- Примите вызов и выслушайте абонента.
- Сверьтесь с информацией из факса.

3. Проверьте абонента
- Задавайте уточняющие вопросы, чтобы получить дополнительные сведения.
- Каждый вопрос можно задать только один раз за разговор.
- Слушайте не только ответы, но и голос.

4. Изучите улики
- Сопоставляйте полученные данные с ответами абонента и информацией из факса и анализаторов.
- Отмечайте в чек-листе как совпадения, так и несоответствия.
Помните: приборы помогают анализировать сигнал, но не определяют автоматически, человек перед вами или Эхо.

5. Не забывайте о кошке
- Кошку можно покормить. Если она сыта, то может устроиться у вас на коленях.
- Иногда кошка ведёт себя странно без видимой причины. Учитывайте, что кошки чувствительнее людей и острее реагируют на различного рода аномалии.

6. Примите решение
- Выдайте одноразовое разрешение, если считаете абонента подлинным.
- Или откажите в доступе, если подозреваете подделку.

7. Следите за состоянием Рауля
- Кофе восстанавливает энергию. Её истощение приводит к снижению рассудка.

Главное правило — не доверяйте одному признаку.
Сопоставляйте ответы, документы и звуковые улики. Даже привычные вещи вокруг могут оказаться не такими надёжными, как кажется.
«Маяк» — последняя линия связи. Будьте внимательны к каждому вызову.`;
    
    if (hintTextObject) hintTextObject.text = HINT_MEMO_TEXT;

    let hintScrollerElement = null;
    let hintScrollerCanvas = null;
    let hintScrollerPositionHandler = null;
    
    function positionHintScroller() {
      if (!hintScrollerElement || !hintScrollerCanvas) return;
      const rect = hintScrollerCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      Object.assign(hintScrollerElement.style, {
        left: `${rect.left + rect.width * (96 / 1920)}px`,
        top: `${rect.top + rect.height * (139 / 1080)}px`,
        width: `${rect.width * (1680 / 1920)}px`,
        height: `${rect.height * (800 / 1080)}px`,
        fontSize: `${Math.max(12, rect.width * (34 / 1920))}px`,
      });
    }
    function mountHintScroller() {
      if (typeof document === "undefined" || typeof window === "undefined" || runtime.isInWorker) return;
      if (hintScrollerElement) return;
      const canvas = document.querySelector("canvas");
      if (!canvas) return;
      const scroller = document.createElement("div");
      scroller.setAttribute("aria-label", "Памятка оператора Маяка");
      scroller.setAttribute("role", "region");
      scroller.tabIndex = 0;
      Object.assign(scroller.style, {
        position: "fixed", zIndex: "999999", overflowY: "auto", overflowX: "hidden",
        boxSizing: "border-box", padding: "0 18px 24px 0", margin: "0",
        color: "rgba(230, 242, 230, 1)", background: "transparent",
        fontFamily: "Arial, sans-serif", fontWeight: "400", lineHeight: "1.28",
        whiteSpace: "pre-wrap", overflowWrap: "break-word", overscrollBehavior: "contain",
        touchAction: "pan-y", scrollbarWidth: "thin", scrollbarColor: "rgba(190, 210, 190, .8) transparent",
        WebkitOverflowScrolling: "touch",
      });
      scroller.textContent = HINT_MEMO_TEXT;
      document.body.appendChild(scroller);
      hintScrollerElement = scroller;
      hintScrollerCanvas = canvas;
      hintScrollerPositionHandler = positionHintScroller;
      window.addEventListener("resize", hintScrollerPositionHandler);
      window.addEventListener("scroll", hintScrollerPositionHandler, true);
      positionHintScroller();
      if (hintTextObject) hintTextObject.isVisible = false;
    }
    function unmountHintScroller() {
      if (hintScrollerPositionHandler && typeof window !== "undefined") {
        window.removeEventListener("resize", hintScrollerPositionHandler);
        window.removeEventListener("scroll", hintScrollerPositionHandler, true);
      }
      hintScrollerElement?.remove();
      hintScrollerElement = null;
      hintScrollerCanvas = null;
      hintScrollerPositionHandler = null;
    }

    const endParts = [
      "endPanel", "endTitleText", "endArrivedText", "endLostText", "endZonesText", "endEchoText", "endEnergyText", "endMenuButton",
    ].flatMap(getAll);

    const DESIGN_CX = 935;
    const DESIGN_CY = 540;
    const DESIGN_W = 1920;
    const DESIGN_H = 1080;
    
    const hudButtons = [hintButton, settingsButton, saveNoticeText].filter(Boolean);
    const followParts = [...hudButtons, ...hintParts, ...endParts, ...shopParts];
    const followOffsets = new Map(followParts.map((o) => [o, { dx: o.x - DESIGN_CX, dy: o.y - DESIGN_CY }]));
    const fullscreenPanels = new Set([...getAll("hintPanel"), ...getAll("endPanel")]);

    const baseSizes = new Map();
    shopParts.forEach((p) => {
      baseSizes.set(p, { x: p.x, y: p.y, w: p.width, h: p.height, fontSize: typeof p.fontSize === "number" ? p.fontSize : null });
    });

    function viewRect(layer) {
      try {
        const vp = layer.getViewport();
        return { cx: vp.left + vp.width / 2, cy: vp.top + vp.height / 2, w: vp.width, h: vp.height };
      } catch (e) {
        const hw = 960, hh = 540;
        const cx = cameraObj ? cameraObj.x : DESIGN_CX;
        const cy = cameraObj ? cameraObj.y : DESIGN_CY;
        return { cx: Math.min(Math.max(cx, hw), runtime.layout.width - hw), cy: Math.min(Math.max(cy, hh), runtime.layout.height - hh), w: 1920, h: 1080 };
      }
    }

    function centerPartsOnScreen(parts) {
      const cachedViews = new Map();
      const shopPanel = getOne("shopPanel");
      const isShopOpen = runtime.globalVars.shopOpen === 1;
      
      let shopScaleX = 1, shopScaleY = 1;
      let basePanelX = 0, basePanelY = 0;

      if (isShopOpen && shopPanel && baseSizes.has(shopPanel)) {
        const view = viewRect(shopPanel.layer);
        const basePanel = baseSizes.get(shopPanel);
        shopScaleX = view.w / basePanel.w;
        shopScaleY = view.h / basePanel.h;
        basePanelX = basePanel.x;
        basePanelY = basePanel.y;
      }

      parts.forEach((p) => {
        let view = cachedViews.get(p.layer);
        if (!view) {
          view = viewRect(p.layer);
          cachedViews.set(p.layer, view);
        }
        const off = followOffsets.get(p);

        if (fullscreenPanels.has(p)) {
          p.x = view.cx; p.y = view.cy; p.width = view.w + 4; p.height = view.h + 4;
        } else if (isShopOpen && baseSizes.has(p)) {
          const base = baseSizes.get(p);
          if (p === shopPanel) {
            p.x = view.cx; p.y = view.cy; p.width = view.w; p.height = view.h;
          } else {
            const relX = base.x - basePanelX;
            const relY = base.y - basePanelY;
            p.x = view.cx + relX * shopScaleX;
            p.y = view.cy + relY * shopScaleY;
            p.width = base.w * shopScaleX;
            p.height = base.h * shopScaleY;
            if (base.fontSize) p.fontSize = Math.max(1, base.fontSize * Math.min(shopScaleX, shopScaleY));
          }
        } else if (off) {
          p.x = view.cx + off.dx; p.y = view.cy + off.dy;
        }
      });
    }

    const listButtonEarly = getOne("listButton");
    const listPanelEarly = getOne("listPanel");
    const listCloseButtonEarly = getOne("listCloseButton");
    const listRowTextsEarly = getAll("listRowText");
    const listCheckCellsEarly = getAll("listCheckCell");
    const listCrossCellsEarly = getAll("listCrossCell");

    const uiToHideInShop = [
      ...energyButtons, changeFrameButton, coffeeButton, shopButton,
      hintButton, settingsButton, endTempButton, dialogTabRadio,
      dialogTabDevices, dialogTabMail, ...radioButtons, dialogText,
      energyText, energyBar, energyBarBG, ...energySegments,
      ...creditsTexts, ...questionItems, listButtonEarly,
      listPanelEarly, listCloseButtonEarly, ...listRowTextsEarly,
      ...listCheckCellsEarly, ...listCrossCellsEarly,
    ].filter(Boolean);

    const savedDomVisibility = new Map();
    let overlay = null;

    function openShop() {
      if (runtime.globalVars.shopOpen === 1) return;
      runtime.globalVars.shopOpen = 1;
      uiToHideInShop.forEach((b) => {
        savedDomVisibility.set(b, b.isVisible);
        b.isVisible = false;
      });
      if (catFace) catFace.isVisible = false;
      centerPartsOnScreen(shopParts);
      shopParts.forEach((p) => {
        p.isVisible = true;
        if (typeof p.moveToTop === "function") p.moveToTop();
      });
      if (typeof shopMessageText?.moveToTop === "function") shopMessageText.moveToTop();
      if (shopMessageText) shopMessageText.text = "";
      refreshShopTexts();
    }

    function closeShop() {
      if (runtime.globalVars.shopOpen === 0) return;
      runtime.globalVars.shopOpen = 0;
      shopParts.forEach((p) => { p.isVisible = false; });
      uiToHideInShop.forEach((b) => {
        b.isVisible = savedDomVisibility.has(b) ? savedDomVisibility.get(b) : true;
      });
      if (coffeeButton) coffeeButton.isVisible = coffeeInStock;
      
      // ФИКС: Вместо принудительного включения, обновляем стейт
      updateCatUI(); 
      
      if (!isShopDisabled) {
        isShopDisabled = true;
        if (shopButton) shopButton.isVisible = false;
        void saveCheckpoint("shop-closed");
      }
    }

    const gameDomButtons = [
      ...energyButtons, changeFrameButton, coffeeButton, shopButton,
      shopCloseButton, shopCoffeeBuyButton, shopCatFoodBuyButton,
      hintButton, settingsButton, endTempButton, dialogTabRadio,
      dialogTabDevices, dialogTabMail, ...radioButtons,
    ].filter(Boolean);

    function openOverlay(kind, parts) {
      if (overlay || runtime.globalVars.isTransitioning === 1) return false;
      overlay = kind;
      gameDomButtons.forEach((b) => {
        savedDomVisibility.set(b, b.isVisible);
        b.isVisible = false;
      });
      if (catFace) catFace.isVisible = false;
      centerPartsOnScreen(parts);
      parts.forEach((p) => {
        p.isVisible = true;
        if (typeof p.moveToTop === "function") p.moveToTop();
      });
      return true;
    }

    function closeOverlay(kind, parts) {
      if (overlay !== kind) return;
      parts.forEach((p) => { p.isVisible = false; });
      gameDomButtons.forEach((b) => {
        b.isVisible = savedDomVisibility.has(b) ? savedDomVisibility.get(b) : true;
      });
      overlay = null;
      
      // ФИКС: Вместо принудительного включения, обновляем стейт
      updateCatUI(); 
    }

    const playClick = () => { try { runtime.callFunction("PlayClick"); } catch (e) {} };
    function goToStartMenu() { runtime.goToLayout(MENU_LAYOUT); }

    const openHint = () => {
      const opened = openOverlay("hint", hintParts);
      if (opened) mountHintScroller();
      return opened;
    };
    const closeHint = () => {
      unmountHintScroller();
      closeOverlay("hint", hintParts);
      if (isTutorialPhase && !isShopDisabled) {
        isTutorialPhase = false;
        setTimeout(() => openShop(), 300);
      }
    };

    function openEndScreen() {
      if (!openOverlay("end", endParts)) return;
      if (endTitleText) endTitleText.text = endText.title;
      endFields.forEach((f) => {
        if (f.obj) f.obj.text = `${f.label}: ${varManager.instVars[f.varName]}`;
      });
    }
    const closeEndScreen = () => closeOverlay("end", endParts);

    hintParts.forEach((p) => { p.isVisible = false; });
    endParts.forEach((p) => { p.isVisible = false; });
    shopParts.forEach((p) => { p.isVisible = false; });
    if (catFace) catFace.isVisible = true;

    if (hintButton)
      hintButton.addEventListener("click", () => {
        if (overlay || runtime.globalVars.isTransitioning === 1) return;
        playClick(); openHint();
      });
    if (hintCloseButton)
      hintCloseButton.addEventListener("click", () => { playClick(); closeHint(); });

    const radioClickAllowed = () => runtime.globalVars.isTransitioning !== 1 && runtime.globalVars.shopOpen !== 1 && !overlay;

    if (askButton)
      askButton.addEventListener("click", () => {
        if (!radioClickAllowed()) return;
        playClick();
        dialogTab = dialogTab === "questions" ? "radio" : "questions";
        hoveredQuestion = -1;
        renderDialog();
      });

    if (transferButton)
      transferButton.addEventListener("click", () => {
        if (!radioClickAllowed()) return;
        playClick();
        if (currentPerson.isEcho) {
            varManager.instVars.ZonesLost += 1;
        } else {
            varManager.instVars.CouriersArrived += 1;
        }
        try { globalThis.sideEcho?.onDecision?.("transfer", callNumber); } catch (e) {}
        startNextCall();
      });

    if (declineButton)
      declineButton.addEventListener("click", () => {
        if (!radioClickAllowed()) return;
        playClick();
        if (!currentPerson.isEcho) {
            varManager.instVars.CouriersLost += 1;
        }
        try { globalThis.sideEcho?.onDecision?.("decline", callNumber); } catch (e) {}
        startNextCall();
      });

    let leavingToMenu = false;
    if (settingsButton)
      settingsButton.addEventListener("click", async () => {
        if (leavingToMenu || overlay || runtime.globalVars.isTransitioning === 1) return;
        leavingToMenu = true;
        settingsButton.isEnabled = false;
        playClick();
        let saved = await saveCheckpoint("settings");
        if (!saved) {
          try {
            await requestDocumentsFromClick({ forcePicker: true });
            saved = await saveCheckpoint("settings");
          } catch (e) {}
        }
        if (saved) goToStartMenu();
        else { leavingToMenu = false; settingsButton.isEnabled = true; }
      });

    if (endTempButton)
      endTempButton.addEventListener("click", () => {
        if (overlay || runtime.globalVars.isTransitioning === 1) return;
        playClick(); openEndScreen();
      });

    if (endMenuButton)
      endMenuButton.addEventListener("click", async () => {
        playClick();
        await storageOperation(deleteCheckpoint);
        goToStartMenu();
      });

    let lastHudX = NaN;
    let lastHudY = NaN;
    const SHOW_HINT_ON_NEW_GAME = true;
    const SHOW_HINT_ON_CONTINUE = false;
    let startHintTicks = (restoredSave ? SHOW_HINT_ON_CONTINUE : SHOW_HINT_ON_NEW_GAME) ? 2 : 0;

    onRuntime("tick2", () => {
      if (runtime.globalVars.shopOpen === 1) centerPartsOnScreen(shopParts);
      
      if (startHintTicks > 0 && --startHintTicks === 0) {
        if (!overlay && (runtime.globalVars.isTransitioning === 1 || !openHint())) startHintTicks = 1;
      }
      
      if (saveNoticeText?.isVisible) {
        const remaining = saveNoticeExpires - Date.now();
        if (remaining <= 0) saveNoticeText.isVisible = false;
        else saveNoticeText.opacity = Math.min(1, remaining / 550);
      }
      
      if (hudButtons.length) {
        const view = viewRect(hudButtons[0].layer);
        if (view.cx !== lastHudX || view.cy !== lastHudY) {
          lastHudX = view.cx; lastHudY = view.cy;
          for (const button of hudButtons) {
            const offset = followOffsets.get(button);
            button.x = view.cx + offset.dx; button.y = view.cy + offset.dy;
          }
        }
      }
      
      if (changeFrameButton) {
        const view = viewRect(changeFrameButton.layer);
        const offsetX = runtime.globalVars.roomSelect === 1 ? 865 : -950;
        changeFrameButton.x = view.cx + offsetX; changeFrameButton.y = view.cy - 200;
      }
      
      // Таймер злости кошки
      if (catState === 2) {
        catAngryTimer -= runtime.dt;
        if (catAngryTimer <= 0) {
          catState = hasBoughtCatFood ? 1 : 0; // Если корм есть, она снова спит (1), иначе исчезает (0)
          updateCatUI();
          void saveCheckpoint("action");
        }
      }
      
      if (listPanel?.isVisible) renderListChecks();
      if (varManager.instVars.Energy !== lastDisplayedEnergy) updateEnergyUI();
      if (varManager.instVars.Credits !== lastDisplayedCredits) updateCreditsUI();
      if (varManager.instVars.Energy <= 0 && !isGameOver && !overlay && runtime.globalVars.isTransitioning === 0) {
        isGameOver = true; openEndScreen();
      }
    });

    if (shopButton) shopButton.addEventListener("click", () => { if (runtime.globalVars.isTransitioning === 1) return; openShop(); });
    if (shopCloseButton) shopCloseButton.addEventListener("click", () => { if (runtime.globalVars.isTransitioning === 1) return; closeShop(); });
    
    if (shopCoffeeBuyButton)
      shopCoffeeBuyButton.addEventListener("click", () => {
        if (runtime.globalVars.shopOpen === 0 || coffeeInStock || varManager.instVars.Credits < COFFEE_PRICE) return;
        varManager.instVars.Credits -= COFFEE_PRICE; coffeeInStock = true;
        updateCreditsUI(); showShopMessage("Кофе куплен"); refreshShopTexts();
        void saveCheckpoint("purchase");
      });

    if (shopCatFoodBuyButton)
      shopCatFoodBuyButton.addEventListener("click", () => {
        if (runtime.globalVars.shopOpen === 0 || varManager.instVars.CatFood >= CATFOOD_MAX || varManager.instVars.Credits < CATFOOD_PRICE) return;
        varManager.instVars.Credits -= CATFOOD_PRICE;
        varManager.instVars.CatFood += 1;
        
        // ПРИ ПОКУПКЕ СТАВИМ ФЛАГ, ЧТО КОРМ КУПЛЕН, И ВКЛЮЧАЕМ 1 КАДР
        hasBoughtCatFood = true;
        catState = 1; 
        updateCatUI(); // Теперь эта функция не покажет кошку поверх магазина
        
        showShopMessage("Корм куплен. Кошка теперь с тобой.");
        void saveCheckpoint("action");
        updateCreditsUI(); refreshShopTexts();
      });

    onRuntime("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (overlay === "hint") { closeHint(); return; }
      if (overlay) return;
      closeShop();
    });

    if (coffeeButton) {
      coffeeButton.isVisible = coffeeInStock;
      coffeeButton.addEventListener("click", () => {
        if (runtime.globalVars.isTransitioning === 1 || runtime.globalVars.shopOpen === 1 || !coffeeInStock) return;
        coffeeInStock = false;
        varManager.instVars.Energy = Math.min(MAX_ENERGY, varManager.instVars.Energy + COFFEE_RESTORE);
        updateEnergyUI(); coffeeButton.isVisible = false;
        void saveCheckpoint("action");
      });
    }

    energyButtons.forEach((button, index) => {
      button.addEventListener("click", () => {
        if (isGameOver || runtime.globalVars.isTransitioning === 1 || runtime.globalVars.shopOpen === 1) return;
        if (devicesUsed[index]) { dialogTab = "devices"; renderDialog(); return; }

        const cost = energyCosts[index] || 1;
        if (varManager.instVars.Energy < cost) {
          if (dialogText) {
            dialogTab = "devices"; renderDialog();
            deviceChatHistory.push(`[color=#ff6666]Недостаточно энергии.[/color]`);
          }
          return;
        }

        devicesUsed[index] = true;
        showDevice(index);
        varManager.instVars.Energy -= cost;
        varManager.instVars.EnergySpent += cost;
        updateEnergyUI();
        void saveCheckpoint("action");

        if (varManager.instVars.Energy <= 0) {
          varManager.instVars.Energy = 0;
          updateEnergyUI();
          isGameOver = true;
          setTimeout(() => {
            if (dialogText) dialogText.text = "ЭНЕРГИЯ ИСЧЕРПАНА. СВЯЗЬ ПРЕРВАНА...";
            openEndScreen();
          }, 600);
        }
      });
    });

    const listButton = listButtonEarly;
    const listPanel = listPanelEarly;
    const listCloseButton = listCloseButtonEarly;
    const listRowTexts = listRowTextsEarly.sort((a, b) => a.y - b.y);
    const listCheckCells = listCheckCellsEarly.sort((a, b) => a.y - b.y);
    const listCrossCells = listCrossCellsEarly.sort((a, b) => a.y - b.y);
    const listParts = [...listRowTexts, ...listCheckCells, ...listCrossCells];
    const setListParts = (visible) => listParts.forEach((p) => { p.isVisible = visible; });

    const checklistTexts = Array.isArray(config.checklist) && config.checklist.length ? config.checklist : ["Есть в списке?", "Совпадают данные?", "Совпадает погода?", "Совпадает фон?", "Однотипен голос?"];
    listRowTexts.forEach((t, i) => { t.text = checklistTexts[i] ?? ""; });

    if (listPanel) listPanel.isVisible = false;
    if (listCloseButton) listCloseButton.isVisible = false;
    const checklistHistory = Object.create(null);
    const savedHistory = restoredSave?.checklistHistory;
    
    if (savedHistory && typeof savedHistory === "object" && !Array.isArray(savedHistory)) {
      for (const [key, marks] of Object.entries(savedHistory)) {
        if (!/^[1-9]\d*$/.test(key) || !Array.isArray(marks)) continue;
        checklistHistory[key] = listRowTexts.map((_, i) => marks[i] === 1 || marks[i] === 2 ? marks[i] : 0);
      }
    }
    
    const restoredMarks = Array.isArray(restoredSave?.listMarks) ? restoredSave.listMarks : (checklistHistory[String(callNumber)] ?? []);
    const listMarks = listRowTexts.map((_, i) => { const saved = restoredMarks[i]; return saved === 1 || saved === 2 ? saved : 0; });

    function renderListChecks() {
      const setFrame = (cell, target) => {
        cell.animationSpeed = 0; cell.stopAnimation();
        if (cell.animationFrame !== target) cell.animationFrame = target;
      };
      listMarks.forEach((mark, i) => {
        if (listCheckCells[i]) setFrame(listCheckCells[i], mark === 1 ? 1 : 0);
        if (listCrossCells[i]) setFrame(listCrossCells[i], mark === 2 ? 1 : 0);
      });
    }
    renderListChecks();
    setListParts(false);

    let saveRevision = Number.isSafeInteger(restoredSave?.revision) && restoredSave.revision >= 0 ? restoredSave.revision : 0;

    function makeCheckpoint() {
      const variables = {};
      for (const name of VAR_NAMES) variables[name] = varManager.instVars[name];
      const currentMarks = listMarks.slice();
      const allCallMarks = Object.fromEntries(Object.entries(checklistHistory).map(([call, marks]) => [call, marks.slice()]));
      allCallMarks[String(callNumber)] = currentMarks.slice();
      return {
        version: 2, revision: ++saveRevision, savedAt: new Date().toISOString(), variables,
        roomSelect: runtime.globalVars.roomSelect === 1 ? 1 : 0, coffeeInStock,
        inventory: { coffeeInStock, catFood: varManager.instVars.CatFood },
        dialog: { tab: dialogTab === "questions" ? "radio" : dialogTab, device: currentDevice },
        questionsAsked: questionsAsked.map(Boolean), devicesUsed: devicesUsed.slice(), 
        chatHistory: chatHistory.slice(), deviceChatHistory: deviceChatHistory.slice(),
        callNumber, currentPerson: currentPerson, shiftPersons: shiftPersons,
        listMarks: currentMarks, checklistHistory: allCallMarks, isShopDisabled: isShopDisabled,
        catState: catState, catAngryTimer: catAngryTimer, echoMistakes: echoMistakes,
        hasBoughtCatFood: hasBoughtCatFood // Сохраняем флаг
      };
    }

    function showSaveNotice(text, isError = false) {
      if (!saveNoticeText || runtime.layout.name !== GAME_LAYOUT) return;
      saveNoticeText.text = text;
      saveNoticeText.colorRgb = isError ? [1, 0.38, 0.36] : [0.36, 1, 0.55];
      saveNoticeText.opacity = 1; saveNoticeText.isVisible = true;
      saveNoticeExpires = Date.now() + (text === "." ? 500 : 3500);
      const view = viewRect(saveNoticeText.layer);
      const off = followOffsets.get(saveNoticeText);
      if (off) { saveNoticeText.x = view.cx + off.dx; saveNoticeText.y = view.cy + off.dy; }
    }
    if (newGameSaveWarning) { showSaveNotice(newGameSaveWarning, true); newGameSaveWarning = ""; }

    function saveCheckpoint(reason) {
      if (!["purchase", "new-call", "settings", "shop-closed", "action"].includes(reason)) return Promise.resolve(false);
      const snapshot = makeCheckpoint();
      return storageOperation(() => writeCheckpoint(snapshot))
        .then(() => {
          if (reason === "action") showSaveNotice(".");
          else showSaveNotice("ИГРА СОХРАНЕНА");
          return true;
        })
        .catch((e) => {
          saveFolderProblem = e?.message || String(e);
          showSaveNotice("ОШИБКА СОХРАНЕНИЯ", true);
          return false;
        });
    }

    function isPointerOver(instance, clientX, clientY) {
      if (!instance) return false;
      const [lx, ly] = instance.layer.cssPxToLayer(clientX, clientY);
      const left = instance.x - instance.width * instance.originX;
      const right = instance.x + instance.width * (1 - instance.originX);
      const top = instance.y - instance.height * instance.originY;
      const bottom = instance.y + instance.height * (1 - instance.originY);
      return lx >= left && lx <= right && ly >= top && ly <= bottom;
    }

    onRuntime("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (runtime.globalVars.isTransitioning === 1 || runtime.globalVars.shopOpen === 1 || overlay || isGameOver) return;

      if (isPointerOver(listButton, e.clientX, e.clientY)) {
        const expanded = !listPanel.isVisible;
        listPanel.isVisible = expanded;
        if (listCloseButton) listCloseButton.isVisible = expanded;
        renderListChecks();
        setListParts(expanded);
        return;
      }

      if (isPointerOver(dialogTabRadio, e.clientX, e.clientY)) {
        if (dialogTab !== "radio" && dialogTab !== "questions") { dialogTab = "radio"; hoveredQuestion = -1; renderDialog(); }
        return;
      }
      if (isPointerOver(dialogTabDevices, e.clientX, e.clientY)) {
        if (dialogTab !== "devices") { dialogTab = "devices"; hoveredQuestion = -1; renderDialog(); }
        return;
      }
      if (isPointerOver(dialogTabMail, e.clientX, e.clientY)) {
        if (dialogTab !== "mail") { dialogTab = "mail"; hoveredQuestion = -1; renderDialog(); }
        return;
      }

      const clickedQuestion = questionAt(e.clientX, e.clientY);
      if (clickedQuestion >= 0) { askQuestion(clickedQuestion); return; }
      if (!listPanel.isVisible) return;

      if (isPointerOver(listCloseButton, e.clientX, e.clientY)) {
        listPanel.isVisible = false;
        if (listCloseButton) listCloseButton.isVisible = false;
        setListParts(false);
        return;
      }

      for (let i = 0; i < listMarks.length; i++) {
        // Обрабатываем галочку (listCheckCells)
        if (isPointerOver(listCheckCells[i], e.clientX, e.clientY)) {
          listMarks[i] = listMarks[i] === 1 ? 0 : 1;
          renderListChecks();
          void saveCheckpoint("action"); 
          
          // Кошка злится, если куплен корм и это Эхо
          if (listMarks[i] === 1 && hasBoughtCatFood && currentPerson && currentPerson.isEcho) {
            if (catState === 1) {
              catState = 2; 
              catAngryTimer = 5; 
              updateCatUI();
              showSaveNotice("Кошка зашипела!", true);
              void saveCheckpoint("action");
            }
          }
          break;
        }
        
        // Обрабатываем крестик (listCrossCells)
        if (isPointerOver(listCrossCells[i], e.clientX, e.clientY)) {
          listMarks[i] = listMarks[i] === 2 ? 0 : 2;
          renderListChecks();
          void saveCheckpoint("action"); 
          
          // Кошка злится, если куплен корм и это Эхо
          if (listMarks[i] === 2 && hasBoughtCatFood && currentPerson && currentPerson.isEcho) {
            if (catState === 1) {
              catState = 2; 
              catAngryTimer = 5; 
              updateCatUI();
              showSaveNotice("Кошка зашипела!", true);
              void saveCheckpoint("action");
            }
          }
          break;
        }
      }
    });

    onRuntime("pointermove", (e) => {
      if (dialogTab !== "questions" || overlay || runtime.globalVars.shopOpen === 1 || isGameOver) return;
      const idx = questionAt(e.clientX, e.clientY);
      const hovered = idx >= 0 && !questionsAsked[idx] ? idx : -1;
      if (hovered === hoveredQuestion) return;
      hoveredQuestion = hovered;
      renderQuestions();
    });

    if (!restoredSave && chatHistory.length === 0) {
      chatHistory.push(`[color=#aaaaaa][i]${callText()}[/i][/color]`);
      if (currentSpeaker) chatHistory.push(`[color=#84e6a6][b]${currentSpeaker.name}:[/b][/color]\n${generatePhrase("greetings")}`);
    }

    updateEnergyUI(); updateCreditsUI(); refreshShopTexts(); renderDialog(); updateCatUI();

    globalThis.sideEcho = {
      config: config,
      addCredits: (amt) => { varManager.instVars.Credits += amt; updateCreditsUI(); },
      spendCredits: (amt) => { varManager.instVars.Credits -= amt; updateCreditsUI(); },
      openShop, closeShop, openHint, closeHint, openEndScreen,
      addStat: (name, amt = 1) => { if (name in varManager.instVars) varManager.instVars[name] += amt; },
      onNewCall: startNextCall,
      getCallNumber: () => callNumber,
      questions: { list: questions, asked: questionsAsked, reset: resetQuestions },
      onQuestionAsked: null,
      onDecision: null,
    };

    cleanup = () => {
      unmountHintScroller();
      for (const [name, cb] of runtimeListeners) runtime.removeEventListener(name, cb);
      clearTimeout(creditsFlashTimer); clearTimeout(messageTimer);
      if (globalThis.sideEcho?.onNewCall) delete globalThis.sideEcho;
    };
  });
});