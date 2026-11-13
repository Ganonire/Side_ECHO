// ================================================================
// SIDE ECHO — main.js
// Логика UI, магазина, списка и вкладок. 
// Переходы, звук и глобальные состояния (isTransitioning, shopOpen) 
// управляются через Event Sheet Construct 3.
// Плюс: кнопки «Настройки»/«Подсказка», окно подсказки и конечный экран.
// ================================================================

runOnStartup(runtime => {
    runtime.addEventListener("beforeprojectstart", async () => {
        if (window.__energyInitDone) return;
        window.__energyInitDone = true;

        const getOne = (name) => runtime.objects[name]?.getFirstInstance() ?? null;
        const getAll = (name) => runtime.objects[name]?.getAllInstances() ?? [];

        // --- Загрузка JSON (Файл tik.json) ---
        let config = {
            settings: { room1X: 935, room2X: 2905, fadeDuration: 0.3 }
        };
        try {
            const response = await fetch(await runtime.assets.getProjectFileUrl("tik.json"));
            config = await response.json();
        } catch (e) { 
            console.warn("Файл tik.json не загружен, используются значения по умолчанию", e); 
        }

        const varManager = runtime.objects.varManager.getFirstInstance();
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
        const cameraObj = getOne("cameraObj");

        // HUD-кнопки, окно подсказки и конечный экран.
        const settingsButton = getOne("settingsButton");
        const hintButton = getOne("hintButton");
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
            if (energyText && energyText.text !== String(energy)) energyText.text = String(energy);
            if (energy === lastDisplayedEnergy) return;
            lastDisplayedEnergy = energy;

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
        const RADIO_TEXT = "Звонок Nº 1";
        let dialogTab = "radio";
        let currentDevice = null;

        function renderDialog() {
            if (dialogTabRadio) dialogTabRadio.animationFrame = dialogTab === "radio" ? 1 : 0;
            if (dialogTabDevices) dialogTabDevices.animationFrame = dialogTab === "devices" ? 1 : 0;
            if (!dialogText) return;
            
            if (dialogTab === "radio") dialogText.text = RADIO_TEXT;
            else dialogText.text = currentDevice === null ? "Приборы: ..." : `Прибор ${currentDevice}: ...`;
        }
        function showRadio() { dialogTab = "radio"; renderDialog(); }
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

        let coffeeInStock = false;
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
        // Макет стартового меню. Пока его нет — кнопки просто пишут
        // предупреждение в консоль. Имя меняется в tik.json (ui.startMenuLayout).
        const START_MENU_LAYOUT = config.ui?.startMenuLayout ?? "StartMenu";
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
        const hudButtons = [settingsButton, hintButton].filter(Boolean);
        const followParts = [...hudButtons, ...hintParts, ...endParts];
        const followOffsets = new Map(
            followParts.map(o => [o, { dx: o.x - DESIGN_CX, dy: o.y - DESIGN_CY }])
        );
        const fullscreenPanels = [...getAll("hintPanel"), ...getAll("endPanel")];

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

        function placeInView(obj) {
            const view = viewRect(obj.layer);
            const off = followOffsets.get(obj);
            obj.x = view.cx + off.dx;
            obj.y = view.cy + off.dy;
            // Полноэкранные панели растягиваем на всю видимую область.
            if (fullscreenPanels.includes(obj)) {
                obj.width = view.w + 4;
                obj.height = view.h + 4;
            }
        }

        // HTML-кнопки рисуются поверх всего, поэтому пока открыт полноэкранный
        // экран, прячем их и потом возвращаем в прежнее состояние.
        const gameDomButtons = [
            ...energyButtons, getOne("changeFrameButton"), coffeeButton, shopButton,
            shopCloseButton, shopCoffeeBuyButton, shopCatFoodBuyButton,
            settingsButton, hintButton, endTempButton
        ].filter(Boolean);
        const savedDomVisibility = new Map();
        let overlay = null; // null | "hint" | "end"

        function openOverlay(kind, parts) {
            if (overlay || runtime.globalVars.isTransitioning === 1) return false;
            overlay = kind;
            gameDomButtons.forEach(b => { savedDomVisibility.set(b, b.isVisible); b.isVisible = false; });
            parts.forEach(p => { placeInView(p); p.isVisible = true; });
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
            let exists = false;
            try { exists = !!runtime.getLayout(START_MENU_LAYOUT); } catch (e) { exists = false; }
            if (!exists) {
                console.warn(`Стартовое меню (макет "${START_MENU_LAYOUT}") ещё не создано.`);
                return false;
            }
            runtime.goToLayout(START_MENU_LAYOUT);
            return true;
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

        if (settingsButton) settingsButton.addEventListener("click", () => {
            if (overlay || runtime.globalVars.isTransitioning === 1) return;
            playClick();
            goToStartMenu();
        });
        if (hintButton) hintButton.addEventListener("click", () => {
            if (overlay || runtime.globalVars.isTransitioning === 1) return;
            playClick();
            openHint();
        });
        if (hintCloseButton) hintCloseButton.addEventListener("click", () => { playClick(); closeHint(); });

        // Временный выход на конечный экран — во второй комнате.
        if (endTempButton) endTempButton.addEventListener("click", () => {
            if (overlay || runtime.globalVars.isTransitioning === 1) return;
            playClick();
            openEndScreen();
        });
        if (endMenuButton) endMenuButton.addEventListener("click", () => {
            playClick();
            // Пока стартового меню нет — просто возвращаемся в игру.
            if (!goToStartMenu()) closeEndScreen();
        });

        // ------------------------------------------------------------
        // TICK (Обновление UI)
        // ------------------------------------------------------------
        runtime.addEventListener("tick2", () => {
            // HUD-кнопки следуют за камерой (правый верхний угол в любой комнате).
            hudButtons.forEach(placeInView);
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
        });

        // Покупка корма
        if (shopCatFoodBuyButton) shopCatFoodBuyButton.addEventListener("click", () => {
            if (runtime.globalVars.shopOpen === 0) return;
            if (varManager.instVars.CatFood >= CATFOOD_MAX) { showShopMessage("Запас корма полон"); return; }
            if (varManager.instVars.Credits < CATFOOD_PRICE) { showShopMessage("Не хватает талонов"); return; }
            
            varManager.instVars.Credits -= CATFOOD_PRICE;
            varManager.instVars.CatFood += 1;
            updateCreditsUI(); showShopMessage("Корм куплен"); refreshShopTexts();
        });

        // Закрытие магазина на Esc
        runtime.addEventListener("keydown", (e) => { 
            if (e.key !== "Escape") return;
            if (overlay === "hint") { closeHint(); return; }
            if (overlay) return;
            closeShop(); 
        });
        
        shopParts.forEach(p => { p.isVisible = false; });

        // Кнопка выпить кофе
        if (coffeeButton) {
            coffeeButton.isVisible = false;
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
                        dialogText.text = "Недостаточно энергии.";
                        dialogTab = "devices";
                        if (dialogTabDevices) dialogTabDevices.animationFrame = 1;
                        if (dialogTabRadio) dialogTabRadio.animationFrame = 0;
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
        const listItems = [getOne("listItem1"), getOne("listItem2"), getOne("listItem3")].filter(Boolean);

        if (listPanel) listPanel.isVisible = false;
        if (listCloseButton) listCloseButton.isVisible = false;
        listItems.forEach(item => { item.isVisible = false; });

        function isPointerOver(instance, clientX, clientY) {
            if (!instance) return false;
            const [lx, ly] = instance.layer.cssPxToLayer(clientX, clientY);
            const left = instance.x - instance.width * instance.originX;
            const right = instance.x + instance.width * (1 - instance.originX);
            const top = instance.y - instance.height * instance.originY;
            const bottom = instance.y + instance.height * (1 - instance.originY);
            return lx >= left && lx <= right && ly >= top && ly <= bottom;
        }

        runtime.addEventListener("pointerdown", (e) => {
            if (runtime.globalVars.isTransitioning === 1) return;
            if (runtime.globalVars.shopOpen === 1) return;
            if (overlay) return;

            if (isPointerOver(listButton, e.clientX, e.clientY)) {
                const expanded = !listPanel.isVisible;
                listPanel.isVisible = expanded;
                if (listCloseButton) listCloseButton.isVisible = expanded;
                listItems.forEach(item => { item.isVisible = expanded; });
                return;
            }

            if (!listPanel.isVisible) {
                if (isPointerOver(dialogTabRadio, e.clientX, e.clientY)) { dialogTab = "radio"; renderDialog(); }
                else if (isPointerOver(dialogTabDevices, e.clientX, e.clientY)) { dialogTab = "devices"; renderDialog(); }
                return;
            }

            if (isPointerOver(listCloseButton, e.clientX, e.clientY)) {
                listPanel.isVisible = false;
                if (listCloseButton) listCloseButton.isVisible = false;
                listItems.forEach(item => { item.isVisible = false; });
                return;
            }

            listItems.forEach(item => {
                if (isPointerOver(item, e.clientX, e.clientY)) {
                    item.animationFrame = item.animationFrame === 0 ? 1 : 0;
                }
            });
        });
        // ------------------------------------------------------------
        // Инициализация
        // ------------------------------------------------------------
        updateEnergyUI();
        updateCreditsUI();
        refreshShopTexts();
        renderDialog();
        // Экспорт данных для Event Sheet (если понадобится)
        window.sideEcho = { 
            config: config,
            addCredits: (amt) => { varManager.instVars.Credits += amt; updateCreditsUI(); }, 
            spendCredits: (amt) => { varManager.instVars.Credits -= amt; updateCreditsUI(); }, 
            openShop, closeShop, openHint, closeHint, openEndScreen,
            // Статистика для конечного экрана: addStat("CouriersArrived") и т.д.
            addStat: (name, amt = 1) => { varManager.instVars[name] += amt; }, 
        };
    });
});