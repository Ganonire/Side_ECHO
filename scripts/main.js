// ================================================================
// SIDE ECHO — main.js (сохранения в My Games)
// Главное меню, контрольные сохранения и игровой UI (оптимизированная версия).
// Автосохранение строго после успешной покупки или появления нового звонка.
// Кнопка «Настройки» в игре тоже сохраняет и уходит в главное меню.
// Обычные действия игрока (приборы, перемещения, списки) НЕ сохраняются.
// Переход между комнатами и звук также управляются Event Sheet Construct 3.
// Меню настроек — заглушка только в StartMenu, на отдельном слое Options.
// ================================================================

runOnStartup(runtime => {
    const LEGACY_SAVE_KEY = "side-echo-checkpoint-v1";
    const SAVE_KEY = "side-echo-checkpoint-json-v2";
    const SAVE_FILENAME = "savegame.json";
    // В Windows WebView2 <documents> указывает на системную папку «Документы».
    const SAVE_FOLDER = "My Games/Side ECHO";
    const SAVE_PATH = `${SAVE_FOLDER}/${SAVE_FILENAME}`;
    const DOCUMENTS_TAG = "<documents>";
    const HANDLE_DB = "side-echo-documents-permission-v2";
    const HANDLE_STORE = "directories";
    const HANDLE_ID = "documents-root";
    const SETTINGS_TYPES = ["endPanel", "settingsTitleText", "settingsInfoText", "settingsBackButton", "settingsPickSaveFolderButton"];
    const GAME_LAYOUT = "Layout 1";
    const MENU_LAYOUT = "StartMenu";
    const VAR_NAMES = ["Energy", "roomSelect", "Credits", "CatFood", "CouriersArrived",
                       "CouriersLost", "ZonesLost", "EchoTalks", "EnergySpent"];
    let queuedStorage = Promise.resolve();
    let loadForNextGame = null;
    let cleanup = () => {};
    let configPromise = null;
    let projectRootHandle = null;
    let saveFolderProblem = "";

    // Static placeholder panel. No audio/display/fullscreen APIs or settings storage.
    function createSettingsController({beforeOpen = () => true, afterClose = () => {}} = {}) {
        const layer = runtime.layout.getLayer("Options");
        const parts = SETTINGS_TYPES.flatMap(name =>
            (runtime.objects[name]?.getAllInstances() ?? []).filter(o => o.layer === layer));
        const back = runtime.objects.settingsBackButton?.getFirstInstance();
        let opened = false;
        parts.forEach(o => { o.isVisible = false; });
        function open() {
            if (opened || beforeOpen() === false) return;
            opened = true;
            parts.forEach(o => { o.isVisible = true; });
        }
        function close() {
            if (!opened) return;
            opened = false;
            parts.forEach(o => { o.isVisible = false; });
            afterClose();
        }
        back?.addEventListener("click", close);
        return {open, close};
    }

    // The packaged JSON is unchanged across room changes and menu returns.
    function loadGameConfig() {
        if (!configPromise) {
            configPromise = runtime.assets.getProjectFileUrl("tik.json")
                .then(url => fetch(url)).then(response => response.json())
                .catch(e => {
                    console.warn("Файл tik.json не загружен, используются значения по умолчанию", e);
                    return {settings: {room1X: 935, room2X: 2905, fadeDuration: 0.3}};
                });
        }
        return configPromise;
    }

    // Последовательность операций защищает от гонки при двух быстрых покупках.
    function storageOperation(action) {
        queuedStorage = queuedStorage.catch(() => {}).then(action);
        return queuedStorage;
    }

    // Два режима запуска:
    // 1. Экспорт Windows WebView2: встроенный объект FileSystem имеет доступ
    //    к <documents> БЕЗ диалогов — настоящий Документы/My Games/Side ECHO.
    // 2. Preview Construct 3 (в том числе установленный PWA): браузерный sandbox.
    //    Один раз выбрать «Документы» вручную, далее используется remembered handle.
    // Ни при каком режиме НЕ подменять отсутствие файла старой копией Local Storage.
    const fsPlugin = runtime.objects.FileSystem;
    function hasDesktopDocuments() {
        return !!fsPlugin?.desktopFeaturesSupported &&
            typeof fsPlugin.hasPickerTag === "function" &&
            fsPlugin.hasPickerTag(DOCUMENTS_TAG);
    }

    function supportsPreviewDocuments() {
        return !runtime.isInWorker && typeof window !== "undefined" &&
            typeof window.showDirectoryPicker === "function" &&
            typeof indexedDB !== "undefined";
    }

    function openHandleDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(HANDLE_DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function getRememberedDocuments() {
        if (!supportsPreviewDocuments()) return null;
        const db = await openHandleDatabase();
        try {
            return await new Promise((resolve, reject) => {
                const request = db.transaction(HANDLE_STORE, "readonly")
                    .objectStore(HANDLE_STORE).get(HANDLE_ID);
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => reject(request.error);
            });
        } finally { db.close(); }
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
        } finally { db.close(); }
    }

    async function hasDocumentsPermission(mode = "read") {
        if (hasDesktopDocuments()) return true;
        if (!projectRootHandle) return false;
        try {
            if (typeof projectRootHandle.queryPermission !== "function") return true;
            return (await projectRootHandle.queryPermission({mode})) === "granted";
        } catch (e) { console.warn("Доступ к Документам не проверен", e); return false; }
    }

    // В Preview requestPermission/showDirectoryPicker нужно вызвать СРАЗУ
    // из клика (до await), иначе браузер потеряет user activation.
    function requestDocumentsFromClick({forcePicker = false} = {}) {
        if (hasDesktopDocuments()) return Promise.resolve(true);
        if (!supportsPreviewDocuments()) {
            return Promise.reject(new Error("Нет доступа к папке Документы в текущем режиме запуска"));
        }
        let requested;
        try {
            if (!forcePicker && projectRootHandle &&
                typeof projectRootHandle.requestPermission === "function") {
                requested = projectRootHandle.requestPermission({mode: "readwrite"})
                    .then(state => {
                        if (state !== "granted") throw new Error("Доступ к Документам не разрешён");
                        return projectRootHandle;
                    });
            } else if (!forcePicker && projectRootHandle) {
                requested = Promise.resolve(projectRootHandle);
            } else {
                requested = window.showDirectoryPicker({
                    id: "side-echo-documents", startIn: "documents", mode: "readwrite"
                });
            }
        } catch (e) { return Promise.reject(e); }
        return requested.then(async handle => {
            projectRootHandle = handle;
            try { await rememberDocuments(handle); }
            catch (e) { console.warn("Папка Документы не запомнена между запусками", e); }
            saveFolderProblem = "";
            return handle;
        });
    }

    // Preview: размещаем файл внутри выбранных «Документов».
    async function getPreviewSaveHandle(create = false) {
        if (!projectRootHandle) return null;
        if (!await hasDocumentsPermission(create ? "readwrite" : "read")) {
            throw new Error("Разреши доступ к папке Документы через Настройки");
        }
        let folder = projectRootHandle;
        for (const component of ["My Games", "Side ECHO"]) {
            try { folder = await folder.getDirectoryHandle(component, {create}); }
            catch (e) {
                if (!create && e?.name === "NotFoundError") return null;
                throw e;
            }
        }
        try { return await folder.getFileHandle(SAVE_FILENAME, {create}); }
        catch (e) { if (!create && e?.name === "NotFoundError") return null; throw e; }
    }

    function parseSave(raw) {
        if (!raw) return null;
        try {
            const data = typeof raw === "string" ? JSON.parse(raw) : raw;
            return (data?.version === 1 || data?.version === 2) &&
                   data?.variables && typeof data.variables.Energy === "number" &&
                   typeof data.variables.Credits === "number" ? data : null;
        } catch (e) {
            console.warn("Некорректный JSON сохранения SIDE ECHO", e);
            return null;
        }
    }

    function isMissingFileError(e) {
        return e?.name === "NotFoundError" || e?.code === "ENOENT" ||
            /not found|no such file|не найден/i.test(e?.message || "");
    }

    // Строго читаем savegame.json с диска; удалённый/повреждённый файл
    // НЕ заменяется копией runtime.storage — кнопка Продолжить отключена.
    async function readCheckpoint() {
        try {
            let content;
            if (hasDesktopDocuments()) {
                content = await fsPlugin.readFile({
                    pickerTag: DOCUMENTS_TAG, folderPath: SAVE_PATH, mode: "text"
                });
            } else {
                const handle = await getPreviewSaveHandle(false);
                if (!handle) return null;
                content = await (await handle.getFile()).text();
            }
            const parsed = parseSave(content);
            if (!parsed) throw new Error("Файл сохранения повреждён или имеет неверный формат");
            saveFolderProblem = "";
            return parsed;
        } catch (e) {
            if (!isMissingFileError(e)) {
                saveFolderProblem = e.message || String(e);
                console.warn("Не удалось прочитать My Games/Side ECHO/savegame.json", e);
            } else saveFolderProblem = "";
            return null;
        }
    }

    // В некоторых desktop-обёртках повторный вызов createFolder() на уже
    // существующей папке возвращает EEXIST. На второй покупке такой сбой
    // прерывал запись ДО writeFile(). Перезаписываем файл напрямую; папку
    // создаём только тогда, когда путь ещё не существует.
    function isExistingFolderError(e) {
        return e?.code === "EEXIST" || e?.name === "AlreadyExistsError" ||
            e?.name === "InvalidModificationError" ||
            /already exists|file exists|уже существует/i.test(e?.message || "");
    }

    async function writeCheckpoint(data) {
        const contents = JSON.stringify(data, null, 2) + "\n";
        if (hasDesktopDocuments()) {
            const write = () => fsPlugin.writeFile({
                pickerTag: DOCUMENTS_TAG,
                folderPath: SAVE_PATH,
                mode: "overwrite", // заменить всё содержимое, НЕ append
                data: contents
            });
            try {
                await write(); // обычный случай: файл и папка уже существуют
            } catch (e) {
                if (!isMissingFileError(e)) throw e;
                // Первая покупка: создаём недостающую папку и пробуем снова.
                try { await fsPlugin.createFolder(DOCUMENTS_TAG, SAVE_FOLDER); }
                catch (folderError) {
                    if (!isExistingFolderError(folderError)) throw folderError;
                }
                await write();
            }
        } else {
            const handle = await getPreviewSaveHandle(true);
            if (!handle) throw new Error("Разреши доступ к папке Документы через Настройки");
            // createWritable() без keepExistingData перезаписывает файл,
            // независимо от того, существовал он до этой покупки или нет.
            const writer = await handle.createWritable({keepExistingData: false});
            try { await writer.write(contents); await writer.close(); }
            catch (e) { try { await writer.abort(); } catch (_) {} throw e; }
        }

        // Не считаем сохранение успешным только по отсутствию ошибки записи:
        // повторно читаем именно диск, чтобы исключить "успешно", но старый JSON.
        const savedOnDisk = await readCheckpoint();
        if (!savedOnDisk || JSON.stringify(savedOnDisk) !== JSON.stringify(data)) {
            throw new Error("После записи файл savegame.json не содержит новые данные");
        }
        // Резерв только для ручного восстановления — не включает «Продолжить».
        try { await runtime.storage.setItem(SAVE_KEY, contents); }
        catch (e) { console.warn("Резервная копия недоступна (JSON сохранён)", e); }
    }

    async function deleteCheckpoint() {
        if (hasDesktopDocuments()) {
            try { await fsPlugin.delete(DOCUMENTS_TAG, SAVE_PATH, false); }
            catch (e) { if (!isMissingFileError(e)) throw e; }
        } else {
            const handle = await getPreviewSaveHandle(false);
            if (handle) {
                // Разрешение на запись проверяем перед удалением существующего файла.
                if (!await hasDocumentsPermission("readwrite")) {
                    throw new Error("Нет разрешения на удаление старого сохранения");
                }
                const folder = await projectRootHandle.getDirectoryHandle("My Games");
                const gameFolder = await folder.getDirectoryHandle("Side ECHO");
                try { await gameFolder.removeEntry(SAVE_FILENAME); }
                catch (e) { if (!isMissingFileError(e)) throw e; }
            }
        }
        await runtime.storage.removeItem(SAVE_KEY);
        await runtime.storage.removeItem(LEGACY_SAVE_KEY);
    }

    async function initStartMenu() {
        const get = name => runtime.objects[name]?.getFirstInstance() ?? null;
        const newButton = get("menuNewGameButton");
        const continueButton = get("menuContinueButton");
        const settingsButton = get("menuSettingsButton");
        const loreButton = get("menuLoreButton");
        const folderButton = get("settingsPickSaveFolderButton");
        const infoText = get("settingsInfoText");
        let checkpoint = null;
        let opening = false;
        loreButton.isEnabled = false;
        continueButton.isEnabled = false;
        settingsButton.isEnabled = true;
        const menuButtons = [newButton, continueButton, settingsButton, loreButton, get("menuTitleText")].filter(Boolean);
        const settingsUI = createSettingsController({
            beforeOpen: () => { menuButtons.forEach(o => o.isVisible = false); return true; },
            afterClose: () => { menuButtons.forEach(o => o.isVisible = true); }
        });

        async function updateFolderInfo() {
            if (!infoText) return;
            if (hasDesktopDocuments()) {
                infoText.text = "СОХРАНЕНИЯ:\nДокументы\\My Games\\Side ECHO\\savegame.json\nПапка создаётся автоматически после покупки.";
                if (folderButton) { folderButton.isEnabled = false; folderButton.isVisible = false; }
            } else if (!supportsPreviewDocuments()) {
                infoText.text = "Недоступна запись в Документы.\nДля автоматических сохранений нужна Windows-версия игры.";
                if (folderButton) folderButton.isEnabled = false;
            } else if (await hasDocumentsPermission()) {
                infoText.text = "ПАПКА ДОКУМЕНТЫ ПОДКЛЮЧЕНА\nMy Games\\Side ECHO\\savegame.json\nПуть запомнен для следующих запусков.";
                if (folderButton) folderButton.isEnabled = true;
            } else if (projectRootHandle) {
                infoText.text = "В Preview требуется повторно разрешить доступ к Документам.\nПуть выбирать заново не нужно.";
                if (folderButton) folderButton.isEnabled = true;
            } else {
                infoText.text = "В Preview один раз выбери папку «Документы».\nВ ней игра создаст My Games\\Side ECHO\\savegame.json.";
                if (folderButton) folderButton.isEnabled = true;
            }
            if (saveFolderProblem) infoText.text += `\n${saveFolderProblem}`;
        }
        async function refreshCheckpoint() {
            try { checkpoint = await readCheckpoint(); }
            catch (e) { console.warn("Не удалось прочитать сохранение", e); checkpoint = null; }
            continueButton.isEnabled = !!checkpoint;
            await updateFolderInfo();
        }

        await queuedStorage.catch(() => {});
        if (!hasDesktopDocuments()) {
            try { projectRootHandle = await getRememberedDocuments(); }
            catch (e) { console.warn("Не удалось восстановить доступ к Документам", e); }
        }
        await refreshCheckpoint();
        settingsButton?.addEventListener("click", () => {
            settingsUI.open();
            if (hasDesktopDocuments() && folderButton) folderButton.isVisible = false;
            void updateFolderInfo();
        });
        folderButton?.addEventListener("click", () => {
            if (hasDesktopDocuments()) return;
            // Запрашиваем доступ из прямого действия пользователя.
            const request = requestDocumentsFromClick({forcePicker: !projectRootHandle});
            void request.then(async () => {
                saveFolderProblem = "";
                await refreshCheckpoint();
            }).catch(async e => {
                if (e?.name !== "AbortError") saveFolderProblem = e.message || String(e);
                await updateFolderInfo();
            });
        });
        const menuEscape = e => { if (e.key === "Escape") settingsUI.close(); };
        runtime.addEventListener("keydown", menuEscape);
        cleanup = () => runtime.removeEventListener("keydown", menuEscape);

        newButton?.addEventListener("click", () => {
            if (opening) return;
            opening = true;
            newButton.isEnabled = false;
            continueButton.isEnabled = false;
            // Получаем разрешение непосредственно из клика на кнопку.
            const request = requestDocumentsFromClick();
            void request.then(() => storageOperation(deleteCheckpoint))
                .then(() => {
                    loadForNextGame = null;
                    runtime.goToLayout(GAME_LAYOUT);
                })
                .catch(async e => {
                    console.warn("Новая игра: папка Документы недоступна", e);
                    saveFolderProblem = e?.name === "AbortError" ? "Выбор папки отменён" : (e.message || String(e));
                    opening = false;
                    newButton.isEnabled = true;
                    await refreshCheckpoint();
                    settingsUI.open();
                });
        });

        continueButton?.addEventListener("click", () => {
            if (opening || !continueButton.isEnabled) return;
            opening = true;
            newButton.isEnabled = false;
            continueButton.isEnabled = false;
            void storageOperation(readCheckpoint).then(saved => {
                if (!saved) throw new Error("Файл сохранения отсутствует или повреждён");
                loadForNextGame = saved;
                runtime.goToLayout(GAME_LAYOUT);
            }).catch(async e => {
                saveFolderProblem = e?.message || String(e);
                opening = false;
                newButton.isEnabled = true;
                await refreshCheckpoint();
            });
        });
    }

    runtime.addEventListener("beforeanylayoutend", () => {
        cleanup();
        cleanup = () => {};
    });

    // Инициализация должна происходить КАЖДЫЙ раз при входе в игровой макет,
    // а не один раз на startup: иначе после возврата из меню кнопки не работают.
    runtime.addEventListener("beforeanylayoutstart", async ({layout}) => {
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
        // Проверка сохранения на входе в новый макет, до первого отображения HUD.
        if (restoredSave) {
            for (const name of VAR_NAMES) {
                if (Object.hasOwn(restoredSave.variables, name)) {
                    varManager.instVars[name] = restoredSave.variables[name];
                }
            }
        }
        runtime.globalVars.isTransitioning = 0;
        runtime.globalVars.shopOpen = 0;
        runtime.globalVars.roomSelect = restoredSave?.roomSelect === 1 ? 1 : 0;
        // Не сбрасываем musicStarted: фоновый трек не должен запускаться второй раз.

        const energyText = getOne("energyText");
        const energyBar = getOne("energyBar");
        const energyBarBG = getOne("energyBarBg");
        
        const energyButtons = [
            getOne("energyButton"), 
            getOne("energyButton2"), 
            getOne("energyButton3")
        ].filter(Boolean);

        const coffeeButton = getOne("coffeeButton");
        const dialogText = getOne("dialogText");
        const dialogTabRadio = getOne("dialogTabRadio");
        const dialogTabDevices = getOne("dialogTabDevices");
        // Режим рации: три кнопки и список вопросов (третья «вкладка»).
        const askButton = getOne("askButton");
        const transferButton = getOne("transferButton");
        const declineButton = getOne("declineButton");
        const radioButtons = [askButton, transferButton, declineButton].filter(Boolean);
        const questionItems = getAll("questionItemText").sort((a, b) => a.y - b.y);
        const cameraObj = getOne("cameraObj");
        if (cameraObj) cameraObj.x = runtime.globalVars.roomSelect === 1 ? 2905 : 935;

        // HUD-кнопки, окно подсказки и конечный экран.
        const hintButton = getOne("hintButton");
        const settingsButton = getOne("settingsButton");
        const saveNoticeText = getOne("saveNoticeText");
        if (saveNoticeText) saveNoticeText.isVisible = false;
        let saveNoticeExpires = 0;
        const hintCloseButton = getOne("hintCloseButton");
        const endMenuButton = getOne("endMenuButton");
        const endTempButton = getOne("endTempButton");
        const energySegments = getAll("energySegment").sort((a, b) => a.x - b.x);

        // Настройки
        const MAX_ENERGY = 15;
        const CURRENCY_LABEL = "ТАЛОНЫ";
        const COFFEE_PRICE = 3;
        const COFFEE_RESTORE = MAX_ENERGY;
        const CATFOOD_PRICE = 2;
        const CATFOOD_MAX = 5;

        let lastDisplayedEnergy = NaN;
        let lastDisplayedCredits = NaN;
        let creditsFlashTimer = null;
        const creditsTexts = getAll("creditsText").concat(getAll("shopCreditsText"));
        const creditsBaseColor = new Map();
        creditsTexts.forEach(t => creditsBaseColor.set(t, [...t.colorRgb]));

        // ------------------------------------------------------------
        // ЛОГИКА UI
        // ------------------------------------------------------------
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

            // Блокировка кнопок, если энергии нет
            const isOutOfEnergy = energy <= 0;
            energyButtons.forEach(btn => { btn.opacity = isOutOfEnergy ? 0.4 : 1.0; });
        }

        function updateCreditsUI() {
            const credits = varManager.instVars.Credits;
            if (credits === lastDisplayedCredits) return;
            const previous = lastDisplayedCredits;
            lastDisplayedCredits = credits;

            const label = `${CURRENCY_LABEL}: ${credits}`;
            creditsTexts.forEach(t => { if (t.text !== label) t.text = label; });

            if (!Number.isNaN(previous)) {
                const flash = credits > previous ? [0.4, 1, 0.5] : [1, 0.4, 0.4];
                creditsTexts.forEach(t => { t.colorRgb = flash; });
                clearTimeout(creditsFlashTimer);
                creditsFlashTimer = setTimeout(() => {
                    creditsTexts.forEach(t => { t.colorRgb = creditsBaseColor.get(t); });
                }, 400);
            }
        }

        // ------------------------------------------------------------
        // ДИАЛОГОВОЕ ОКНО
        // ------------------------------------------------------------
        // Номер звонка. Шаблон надписи берётся из tik.json (texts.radioCall):
        // последнее число в нём заменяется текущим номером.
        const CALL_TEMPLATE = config.texts?.radioCall ?? "Звонок Nº 1";
        let callNumber = Number.isInteger(restoredSave?.callNumber) && restoredSave.callNumber >= 1
            ? restoredSave.callNumber : 1;
        const callText = () => CALL_TEMPLATE.replace(/\d+\s*$/, String(callNumber));
        let dialogTab = restoredSave?.dialog?.tab === "devices" ? "devices" : "radio";
        let currentDevice = Number.isInteger(restoredSave?.dialog?.device)
            ? restoredSave.dialog.device : null;

        // Режимы окна: "radio" (рация), "questions" (рация + список вопросов,
        // третья «вкладка») и "devices" (приборы). Кнопки рации видны
        // в первых двух режимах.
        function renderDialog() {
            const radioMode = dialogTab !== "devices";
            if (dialogTabRadio) dialogTabRadio.animationFrame = radioMode ? 1 : 0;
            if (dialogTabDevices) dialogTabDevices.animationFrame = radioMode ? 0 : 1;
            radioButtons.forEach(b => { b.isVisible = radioMode; });
            renderQuestions();
            if (!dialogText) return;

            if (radioMode) dialogText.text = callText();
            else dialogText.text = currentDevice === null ? "Приборы: ..." : `Прибор ${currentDevice}: ...`;
        }

        // ------------------------------------------------------------
        // ВОПРОСЫ СОБЕСЕДНИКУ. Тексты лежат в tik.json -> questions.
        // Каждый вопрос можно задать один раз: после этого он серый и
        // зачёркнутый. При наведении незаданный вопрос подчёркивается.
        // ------------------------------------------------------------
        const questions = (Array.isArray(config.questions) && config.questions.length
            ? config.questions
            : ["Какой груз вы доставляете?",
               "Какие погодные условия в вашем районе?",
               "В какой местности вы сейчас находитесь?"]
        ).slice(0, questionItems.length);
        const questionsAsked = questions.map((_, i) => restoredSave?.questionsAsked?.[i] === true);
        let hoveredQuestion = -1;
        questionItems.forEach(item => {
            // Подчёркивание и зачёркивание делаются BBCode-тегами [u] и [s].
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
            return questionItems.findIndex((item, i) =>
                i < questions.length && isPointerOver(item, clientX, clientY));
        }

        function askQuestion(i) {
            if (i < 0 || questionsAsked[i]) return;
            questionsAsked[i] = true;
            renderQuestions();
            // Точка интеграции: здесь позже появится ответ собеседника.
            try { globalThis.sideEcho?.onQuestionAsked?.(i, questions[i]); }
            catch (e) { console.error("onQuestionAsked", e); }
        }

        // Для нового звонка: все вопросы снова доступны.
        function resetQuestions() {
            questionsAsked.fill(false);
            hoveredQuestion = -1;
            renderQuestions();
        }

        // Следующий звонок: номер растёт, вопросы и чек-лист начинаются заново,
        // окно возвращается на вкладку рации, результаты приборов сбрасываются.
        // Контрольная точка сохраняется (reason "new-call", без уведомления).
        function startNextCall() {
            callNumber += 1;
            resetQuestions();
            listMarks.fill(0);
            renderListChecks();
            currentDevice = null;
            dialogTab = "radio";
            hoveredQuestion = -1;
            renderDialog();
            return saveCheckpoint("new-call");
        }
        function showDeviceTab() { dialogTab = "devices"; renderDialog(); }
        function showDevice(index) { currentDevice = index; showDeviceTab(); }

        // ------------------------------------------------------------
        // МАГАЗИН
        // ------------------------------------------------------------
        const shopButton = getOne("shopButton");
        const shopCloseButton = getOne("shopCloseButton");
        const shopCoffeeBuyButton = getOne("shopCoffeeBuyButton");
        const shopCatFoodBuyButton = getOne("shopCatFoodBuyButton");
        const shopCoffeeText = getOne("shopCoffeeText");
        const shopCatFoodText = getOne("shopCatFoodText");
        const shopMessageText = getOne("shopMessageText");

        const SHOP_PART_NAMES = ["shopPanel", "shopTitleText", "shopCreditsText", "shopMessageText", "shopCoffeeText", "shopCatFoodText", "shopCloseButton", "shopCoffeeBuyButton", "shopCatFoodBuyButton"];
        const shopParts = SHOP_PART_NAMES.flatMap(getAll);
        const coveredButtons = [...energyButtons, getOne("changeFrameButton")].filter(Boolean);

        let coffeeInStock = restoredSave?.coffeeInStock === true;
        let messageTimer = null;

        function showShopMessage(text) {
            if (!shopMessageText) return;
            shopMessageText.text = text;
            clearTimeout(messageTimer);
            messageTimer = setTimeout(() => { shopMessageText.text = ""; }, 1800);
        }

        function refreshShopTexts() {
            if (shopCoffeeText) shopCoffeeText.text = `Кофе (цена: ${COFFEE_PRICE})${coffeeInStock ? " — куплен" : ""}\nВосстанавливает энергию`;
            if (shopCatFoodText) shopCatFoodText.text = `Кошачий корм (цена: ${CATFOOD_PRICE})\nЗапас: ${varManager.instVars.CatFood}/${CATFOOD_MAX}`;
        }

        function openShop() {
            if (runtime.globalVars.shopOpen === 1) return;
            runtime.globalVars.shopOpen = 1; // Меняем глобальную переменную Construct 3
            
            coveredButtons.forEach(b => { b.isVisible = false; });
            if (coffeeButton) coffeeButton.isVisible = false;
            shopParts.forEach(p => { p.isVisible = true; });
            if (shopMessageText) shopMessageText.text = "";
            refreshShopTexts();
        }

        function closeShop() {
            if (runtime.globalVars.shopOpen === 0) return;
            runtime.globalVars.shopOpen = 0; // Меняем глобальную переменную Construct 3
            
            shopParts.forEach(p => { p.isVisible = false; });
            coveredButtons.forEach(b => { b.isVisible = true; });
            if (coffeeButton) coffeeButton.isVisible = coffeeInStock;
        }

        // ------------------------------------------------------------
        // HUD-КНОПКИ, ПОДСКАЗКА И КОНЕЧНЫЙ ЭКРАН
        // ------------------------------------------------------------
        // Макет реального стартового меню. Возврат не создает сохранение.
        const endText = {
            title: config.end?.title ?? "ИТОГИ СМЕНЫ",
            arrived: config.end?.arrived ?? "Курьеров дошло",
            lost: config.end?.lost ?? "Курьеров потеряно",
            zonesLost: config.end?.zonesLost ?? "Зон потеряно",
            echoTalks: config.end?.echoTalks ?? "Разговоров с Эхо",
            energySpent: config.end?.energySpent ?? "Энергии потрачено"
        };

        // Поля конечного экрана: объект -> что показывать (переменная varManager).
        const endFields = [
            ["endArrivedText", endText.arrived, "CouriersArrived"],
            ["endLostText", endText.lost, "CouriersLost"],
            ["endZonesText", endText.zonesLost, "ZonesLost"],
            ["endEchoText", endText.echoTalks, "EchoTalks"],
            ["endEnergyText", endText.energySpent, "EnergySpent"]
        ].map(([name, label, varName]) => ({ obj: getOne(name), label, varName }));
        const endTitleText = getOne("endTitleText");

        const hintParts = ["hintPanel", "hintText", "hintCloseButton"].flatMap(getAll);
        const endParts = ["endPanel", "endTitleText", "endArrivedText", "endLostText",
                          "endZonesText", "endEchoText", "endEnergyText", "endMenuButton"].flatMap(getAll);

        // HUD-кнопки и окна привязаны к ВИДИМОЙ области экрана, а не к
        // точке cameraObj: макет ограничен по краям (прокрутка не выходит за
        // его границы), поэтому реальный центр экрана может отличаться от
        // cameraObj.x. Раскладка рисовалась вокруг центра (935, 540).
        const DESIGN_CX = 935;
        const DESIGN_CY = 540;
        const hudButtons = [hintButton, settingsButton, saveNoticeText].filter(Boolean);
        const followParts = [...hudButtons, ...hintParts, ...endParts];
        const followOffsets = new Map(
            followParts.map(o => [o, { dx: o.x - DESIGN_CX, dy: o.y - DESIGN_CY }])
        );
        const fullscreenPanels = new Set([...getAll("hintPanel"), ...getAll("endPanel")]);

        // Видимая область слоя в координатах слоя: центр и размер.
        function viewRect(layer) {
            try {
                const vp = layer.getViewport();
                return { cx: vp.left + vp.width / 2, cy: vp.top + vp.height / 2, w: vp.width, h: vp.height };
            } catch (e) {
                // Запасной вариант: центр камеры, зажатый в границы макета.
                const hw = 960, hh = 540;
                const cx = cameraObj ? cameraObj.x : DESIGN_CX;
                const cy = cameraObj ? cameraObj.y : DESIGN_CY;
                return {
                    cx: Math.min(Math.max(cx, hw), runtime.layout.width - hw),
                    cy: Math.min(Math.max(cy, hh), runtime.layout.height - hh),
                    w: 1920, h: 1080
                };
            }
        }

        // HTML-кнопки рисуются поверх всего, поэтому пока открыт полноэкранный
        // экран, прячем их и потом возвращаем в прежнее состояние.
        const gameDomButtons = [
            ...energyButtons, getOne("changeFrameButton"), coffeeButton, shopButton,
            shopCloseButton, shopCoffeeBuyButton, shopCatFoodBuyButton,
            hintButton, settingsButton, endTempButton, ...radioButtons
        ].filter(Boolean);
        const savedDomVisibility = new Map();
        let overlay = null; // null | "hint" | "end"

        function openOverlay(kind, parts) {
            if (overlay || runtime.globalVars.isTransitioning === 1) return false;
            overlay = kind;
            gameDomButtons.forEach(b => { savedDomVisibility.set(b, b.isVisible); b.isVisible = false; });
            const cachedViews = new Map();
            parts.forEach(p => {
                let view = cachedViews.get(p.layer);
                if (!view) { view = viewRect(p.layer); cachedViews.set(p.layer, view); }
                const off = followOffsets.get(p);
                p.x = view.cx + off.dx;
                p.y = view.cy + off.dy;
                if (fullscreenPanels.has(p)) {
                    p.width = view.w + 4;
                    p.height = view.h + 4;
                }
                p.isVisible = true;
            });
            return true;
        }

        function closeOverlay(kind, parts) {
            if (overlay !== kind) return;
            parts.forEach(p => { p.isVisible = false; });
            gameDomButtons.forEach(b => {
                b.isVisible = savedDomVisibility.has(b) ? savedDomVisibility.get(b) : true;
            });
            overlay = null;
        }

        const playClick = () => { try { runtime.callFunction("PlayClick"); } catch (e) { /* функции нет — без звука */ } };

        function goToStartMenu() {
            runtime.goToLayout(MENU_LAYOUT);
        }

        const openHint = () => openOverlay("hint", hintParts);
        const closeHint = () => closeOverlay("hint", hintParts);

        function openEndScreen() {
            if (!openOverlay("end", endParts)) return;
            if (endTitleText) endTitleText.text = endText.title;
            endFields.forEach(f => {
                if (f.obj) f.obj.text = `${f.label}: ${varManager.instVars[f.varName]}`;
            });
        }
        const closeEndScreen = () => closeOverlay("end", endParts);

        // Скрыто до открытия.
        hintParts.forEach(p => { p.isVisible = false; });
        endParts.forEach(p => { p.isVisible = false; });

        if (hintButton) hintButton.addEventListener("click", () => {
            if (overlay || runtime.globalVars.isTransitioning === 1) return;
            playClick();
            openHint();
        });
        if (hintCloseButton) hintCloseButton.addEventListener("click", () => { playClick(); closeHint(); });

        // Кнопки рации. «Задать вопрос» открывает/закрывает список вопросов.
        // «Передать координаты» и «Отклонить» завершают звонок и начинают
        // следующий. Чтобы учесть решение игрока, подпишитесь:
        // globalThis.sideEcho.onDecision = (kind, callNumber) => {...}
        // (kind: "transfer" | "decline"; вызывается ДО начала следующего звонка).
        const radioClickAllowed = () =>
            runtime.globalVars.isTransitioning !== 1 && runtime.globalVars.shopOpen !== 1 && !overlay;
        if (askButton) askButton.addEventListener("click", () => {
            if (!radioClickAllowed()) return;
            playClick();
            dialogTab = dialogTab === "questions" ? "radio" : "questions";
            hoveredQuestion = -1;
            renderDialog();
        });
        for (const [button, kind] of [[transferButton, "transfer"], [declineButton, "decline"]]) {
            if (!button) continue;
            button.addEventListener("click", () => {
                if (!radioClickAllowed()) return;
                playClick();
                try { globalThis.sideEcho?.onDecision?.(kind, callNumber); }
                catch (e) { console.error("onDecision", e); }
                startNextCall();
            });
        }

        // «Настройки»: сначала сохраняем игру, и только после успешной записи
        // уходим в главное меню. Если сохранить не удалось, остаёмся в игре
        // и показываем «ОШИБКА СОХРАНЕНИЯ», чтобы прогресс не потерялся молча.
        let leavingToMenu = false;
        if (settingsButton) settingsButton.addEventListener("click", async () => {
            if (leavingToMenu || overlay || runtime.globalVars.isTransitioning === 1) return;
            leavingToMenu = true;
            settingsButton.isEnabled = false;
            playClick();
            const saved = await saveCheckpoint("settings");
            if (saved) {
                goToStartMenu();
            } else {
                leavingToMenu = false;
                settingsButton.isEnabled = true;
            }
        });

        // Временный выход на конечный экран — во второй комнате.
        if (endTempButton) endTempButton.addEventListener("click", () => {
            if (overlay || runtime.globalVars.isTransitioning === 1) return;
            playClick();
            openEndScreen();
        });
        if (endMenuButton) endMenuButton.addEventListener("click", () => {
            playClick();
            goToStartMenu();
        });

        // ------------------------------------------------------------
        // TICK (Обновление UI)
        // ------------------------------------------------------------
        let lastHudX = NaN;
        let lastHudY = NaN;
        // Подсказка открывается при старте игры (новая игра).
        // Ждём пару кадров, чтобы камера и видимая область уже встали на место.
        const SHOW_HINT_ON_NEW_GAME = true;
        const SHOW_HINT_ON_CONTINUE = false;
        let startHintTicks = (restoredSave ? SHOW_HINT_ON_CONTINUE : SHOW_HINT_ON_NEW_GAME) ? 2 : 0;
        onRuntime("tick2", () => {
            if (startHintTicks > 0 && --startHintTicks === 0) {
                // Если переход ещё идёт, попробуем на следующем кадре.
                if (!overlay && (runtime.globalVars.isTransitioning === 1 || !openHint())) startHintTicks = 1;
            }
            if (saveNoticeText?.isVisible) {
                const remaining = saveNoticeExpires - Date.now();
                if (remaining <= 0) saveNoticeText.isVisible = false;
                else saveNoticeText.opacity = Math.min(1, remaining / 550);
            }
            // One viewport query per frame instead of one per HUD button, and
            // no position writes when the camera has not moved.
            if (hudButtons.length) {
                const view = viewRect(hudButtons[0].layer);
                if (view.cx !== lastHudX || view.cy !== lastHudY) {
                    lastHudX = view.cx;
                    lastHudY = view.cy;
                    for (const button of hudButtons) {
                        const offset = followOffsets.get(button);
                        button.x = view.cx + offset.dx;
                        button.y = view.cy + offset.dy;
                    }
                }
            }
            // Движок/события не должны сбрасывать крестики после загрузки.
            if (listPanel?.isVisible) renderListChecks();
            if (varManager.instVars.Energy !== lastDisplayedEnergy) updateEnergyUI();
            if (varManager.instVars.Credits !== lastDisplayedCredits) updateCreditsUI();
        });

        // ------------------------------------------------------------
        // ОБРАБОТЧИКИ КЛИКОВ
        // ------------------------------------------------------------
        
        // Кнопка магазина (открыть/закрыть)
        if (shopButton) shopButton.addEventListener("click", () => {
            if (runtime.globalVars.isTransitioning === 1) return;
            openShop();
        });
        
        if (shopCloseButton) shopCloseButton.addEventListener("click", () => {
            if (runtime.globalVars.isTransitioning === 1) return;
            closeShop();
        });
        
        // Покупка кофе
        if (shopCoffeeBuyButton) shopCoffeeBuyButton.addEventListener("click", () => {
            if (runtime.globalVars.shopOpen === 0) return;
            if (coffeeInStock) { showShopMessage("Кофе уже куплен"); return; }
            if (varManager.instVars.Credits < COFFEE_PRICE) { showShopMessage("Не хватает талонов"); return; }
            
            varManager.instVars.Credits -= COFFEE_PRICE;
            coffeeInStock = true;
            updateCreditsUI(); showShopMessage("Кофе куплен"); refreshShopTexts();
            void saveCheckpoint("purchase");
        });

        // Покупка корма
        if (shopCatFoodBuyButton) shopCatFoodBuyButton.addEventListener("click", () => {
            if (runtime.globalVars.shopOpen === 0) return;
            if (varManager.instVars.CatFood >= CATFOOD_MAX) { showShopMessage("Запас корма полон"); return; }
            if (varManager.instVars.Credits < CATFOOD_PRICE) { showShopMessage("Не хватает талонов"); return; }
            
            varManager.instVars.Credits -= CATFOOD_PRICE;
            varManager.instVars.CatFood += 1;
            updateCreditsUI(); showShopMessage("Корм куплен"); refreshShopTexts();
            void saveCheckpoint("purchase");
        });

        // Закрытие магазина на Esc
        onRuntime("keydown", (e) => { 
            if (e.key !== "Escape") return;
            if (overlay === "hint") { closeHint(); return; }
            if (overlay) return;
            closeShop(); 
        });
        
        shopParts.forEach(p => { p.isVisible = false; });

        // Кнопка выпить кофе
        if (coffeeButton) {
            coffeeButton.isVisible = coffeeInStock;
            coffeeButton.addEventListener("click", () => {
                if (runtime.globalVars.isTransitioning === 1) return;
                if (runtime.globalVars.shopOpen === 1 || !coffeeInStock) return;
                
                coffeeInStock = false;
                varManager.instVars.Energy = Math.min(MAX_ENERGY, varManager.instVars.Energy + COFFEE_RESTORE);
                updateEnergyUI(); coffeeButton.isVisible = false;
            });
        }

        // Кнопки приборов (энергии)
        energyButtons.forEach((button, index) => {
            button.addEventListener("click", () => {
                if (runtime.globalVars.isTransitioning === 1) return;
                if (runtime.globalVars.shopOpen === 1) return;
                
                // Проверка энергии
                if (varManager.instVars.Energy <= 0) {
                    if (dialogText) {
                        dialogTab = "devices";
                        renderDialog();
                        dialogText.text = "Недостаточно энергии.";
                    }
                    return;
                }
                showDevice(index);
                varManager.instVars.Energy -= 1;
                varManager.instVars.EnergySpent += 1; // для конечного экрана
                updateEnergyUI();
            });
        });

        // ------------------------------------------------------------
        // СПИСОК И ВКЛАДКИ
        // ------------------------------------------------------------
        const listButton = getOne("listButton");
        const listPanel = getOne("listPanel");
        const listCloseButton = getOne("listCloseButton");
        // Чек-лист: 5 строк текста и две колонки клеток — «галочка» и «крестик».
        const listRowTexts = getAll("listRowText").sort((a, b) => a.y - b.y);
        const listCheckCells = getAll("listCheckCell").sort((a, b) => a.y - b.y);
        const listCrossCells = getAll("listCrossCell").sort((a, b) => a.y - b.y);
        const listParts = [...listRowTexts, ...listCheckCells, ...listCrossCells];
        const setListParts = (visible) => listParts.forEach(p => { p.isVisible = visible; });
        // Тексты пунктов лежат в tik.json -> checklist.
        const checklistTexts = Array.isArray(config.checklist) && config.checklist.length
            ? config.checklist
            : ["Есть в списке ожидаемых?", "Совпадают ли данные (частота, груз, маршрут)?",
               "Совпадает ли погода?", "Совпадает ли фоновый шум?", "Однотипен ли голос?"];
        listRowTexts.forEach((t, i) => { t.text = checklistTexts[i] ?? ""; });

        if (listPanel) listPanel.isVisible = false;
        if (listCloseButton) listCloseButton.isVisible = false;
        // Отметки по строкам: 0 — нет, 1 — галочка (подтверждено), 2 — крестик (опровергнуто).
        const listMarks = listRowTexts.map((_, i) => {
            const saved = restoredSave?.listMarks?.[i];
            return saved === 1 || saved === 2 ? saved : 0;
        });
        function renderListChecks() {
            // Клетки не должны сами листать кадры: 0 — пустая, 1 — отмеченная.
            const setFrame = (cell, target) => {
                cell.animationSpeed = 0;
                cell.stopAnimation();
                if (cell.animationFrame !== target) cell.animationFrame = target;
            };
            listMarks.forEach((mark, i) => {
                if (listCheckCells[i]) setFrame(listCheckCells[i], mark === 1 ? 1 : 0);
                if (listCrossCells[i]) setFrame(listCrossCells[i], mark === 2 ? 1 : 0);
            });
        }
        renderListChecks();
        setListParts(false);

        // Счётчик отличает даже две быстрые покупки с одинаковым savedAt.
        // Старые сохранения без revision остаются совместимыми.
        let saveRevision = Number.isSafeInteger(restoredSave?.revision) && restoredSave.revision >= 0
            ? restoredSave.revision : 0;

        // Snapshot копируется непосредственно в момент контрольной точки, а не
        // после завершения асинхронной записи (иначе могли бы попасть новые действия).
        function makeCheckpoint() {
            const variables = {};
            for (const name of VAR_NAMES) variables[name] = varManager.instVars[name];
            return {
                version: 2,
                revision: ++saveRevision,
                savedAt: new Date().toISOString(),
                variables,
                roomSelect: runtime.globalVars.roomSelect === 1 ? 1 : 0,
                coffeeInStock,
                dialog: { tab: dialogTab === "questions" ? "radio" : dialogTab, device: currentDevice },
                questionsAsked: questionsAsked.map(Boolean),
                callNumber,
                listMarks: listMarks.slice()
            };
        }

        function showSaveNotice(text, isError = false) {
            if (!saveNoticeText || runtime.layout.name !== GAME_LAYOUT) return;
            saveNoticeText.text = text;
            saveNoticeText.colorRgb = isError ? [1, 0.38, 0.36] : [0.36, 1, 0.55];
            saveNoticeText.opacity = 1;
            saveNoticeText.isVisible = true;
            saveNoticeExpires = Date.now() + 2500;
            // Корректная позиция даже если покупка сделана сразу после смены комнаты.
            const view = viewRect(saveNoticeText.layer);
            const off = followOffsets.get(saveNoticeText);
            if (off) { saveNoticeText.x = view.cx + off.dx; saveNoticeText.y = view.cy + off.dy; }
        }

        // Возвращает Promise<boolean>: true — файл записан и проверен на диске.
        function saveCheckpoint(reason) {
            if (reason !== "purchase" && reason !== "new-call" && reason !== "settings") {
                return Promise.resolve(false);
            }
            // Снимок на момент покупки, ДО асинхронной записи. Последующие
            // клики/расход энергии не включаются в уже созданный checkpoint.
            const snapshot = makeCheckpoint();
            return storageOperation(() => writeCheckpoint(snapshot))
                .then(() => {
                    if (reason === "purchase") showSaveNotice("ИГРА СОХРАНЕНА");
                    return true;
                })
                .catch(e => {
                    console.error("Сохранение SIDE ECHO не удалось", e);
                    if (reason !== "new-call") showSaveNotice("ОШИБКА СОХРАНЕНИЯ", true);
                    return false;
                });
        }

        // Новый звонок начинается кнопками «Передать координаты» / «Отклонить»
        // или вызовом sideEcho.onNewCall() из других систем: оба пути ведут в
        // startNextCall(), который и сохраняет контрольную точку.
        // Открытие вкладки радио само по себе сохранение НЕ вызывает.

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
            if (runtime.globalVars.isTransitioning === 1) return;
            if (runtime.globalVars.shopOpen === 1) return;
            if (overlay) return;

            if (isPointerOver(listButton, e.clientX, e.clientY)) {
                const expanded = !listPanel.isVisible;
                listPanel.isVisible = expanded;
                if (listCloseButton) listCloseButton.isVisible = expanded;
                renderListChecks();
                setListParts(expanded);
                return;
            }

            // Окно диалога: вкладки и список вопросов (чек-лист его не перекрывает).
            if (isPointerOver(dialogTabRadio, e.clientX, e.clientY)) {
                if (dialogTab !== "radio") { dialogTab = "radio"; hoveredQuestion = -1; renderDialog(); }
                return;
            }
            if (isPointerOver(dialogTabDevices, e.clientX, e.clientY)) {
                if (dialogTab !== "devices") { dialogTab = "devices"; hoveredQuestion = -1; renderDialog(); }
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

            // Клик по клетке: колонка «галочка» ставит 1, колонка «крестик» — 2;
            // повторный клик по той же клетке снимает отметку.
            for (let i = 0; i < listMarks.length; i++) {
                if (isPointerOver(listCheckCells[i], e.clientX, e.clientY)) {
                    listMarks[i] = listMarks[i] === 1 ? 0 : 1;
                    renderListChecks();
                    break;
                }
                if (isPointerOver(listCrossCells[i], e.clientX, e.clientY)) {
                    listMarks[i] = listMarks[i] === 2 ? 0 : 2;
                    renderListChecks();
                    break;
                }
            }
        });
        // Наведение на вопрос: незаданный вопрос подчёркивается.
        onRuntime("pointermove", (e) => {
            if (dialogTab !== "questions" || overlay || runtime.globalVars.shopOpen === 1) return;
            const idx = questionAt(e.clientX, e.clientY);
            const hovered = idx >= 0 && !questionsAsked[idx] ? idx : -1;
            if (hovered === hoveredQuestion) return;
            hoveredQuestion = hovered;
            renderQuestions();
        });

        // ------------------------------------------------------------
        // Инициализация
        // ------------------------------------------------------------
        updateEnergyUI();
        updateCreditsUI();
        refreshShopTexts();
        renderDialog();
        // Экспорт данных для Event Sheet (если понадобится)
        globalThis.sideEcho = { 
            config: config,
            addCredits: (amt) => { varManager.instVars.Credits += amt; updateCreditsUI(); }, 
            spendCredits: (amt) => { varManager.instVars.Credits -= amt; updateCreditsUI(); }, 
            openShop, closeShop, openHint, closeHint, openEndScreen,
            // Статистика для конечного экрана: addStat("CouriersArrived") и т.д.
            addStat: (name, amt = 1) => { if (name in varManager.instVars) varManager.instVars[name] += amt; },
            onNewCall: startNextCall,
            getCallNumber: () => callNumber,
            // Вопросы к собеседнику: списки и сброс для нового звонка.
            questions: { list: questions, asked: questionsAsked, reset: resetQuestions },
            // Подписки: onQuestionAsked(index, text), onDecision("transfer"|"decline").
            onQuestionAsked: null,
            onDecision: null,
        };

        cleanup = () => {
            for (const [name, cb] of runtimeListeners) runtime.removeEventListener(name, cb);
            clearTimeout(creditsFlashTimer);
            clearTimeout(messageTimer);
            if (globalThis.sideEcho?.onNewCall) delete globalThis.sideEcho;
        };
    });
});