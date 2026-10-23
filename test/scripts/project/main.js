runOnStartup(runtime => {
    runtime.addEventListener("beforeprojectstart", () => {
        // Защита от повторной инициализации (от дублей скрипта).
        if (window.__energyInitDone) return;
        window.__energyInitDone = true;

        const varManager = runtime.objects.varManager.getFirstInstance();
        const energyText = runtime.objects.energyText.getFirstInstance();
        const energyBar = runtime.objects.energyBar.getFirstInstance();
        const energyBarBG = runtime.objects.energyBarBG
            ? runtime.objects.energyBarBG.getFirstInstance()
            : null;
        const energyButton = runtime.objects.energyButton.getFirstInstance();
        const energyButton2 = runtime.objects.energyButton2.getFirstInstance();
        const energyButton3 = runtime.objects.energyButton3.getFirstInstance();
        const changeFrameButton = runtime.objects.changeFrameButton.getFirstInstance();
        const cameraObj = runtime.objects.cameraObj.getFirstInstance();
        const audioObj = runtime.objects.Audio
            ? runtime.objects.Audio.getFirstInstance()
            : null;

        // Кнопка кофе на второй панели. Если объекта пока нет
        // в проекте, работаем без него — ничего не сломается.
        const coffeeButton = runtime.objects.coffeeButton
            ? runtime.objects.coffeeButton.getFirstInstance()
            : null;

        // Сегменты шкалы: все копии спрайта energySegment на layout,
        // отсортированные слева направо по позиции X.
        const energySegments = runtime.objects.energySegment
            ? runtime.objects.energySegment.getAllInstances()
            : [];
        energySegments.sort((a, b) => a.x - b.x);

        // Полное значение энергии (вернули старую систему: до 100).
        const MAX_ENERGY = 100;
        let lastDisplayedEnergy = NaN;

        // ============================================================
        // Звук: фоновая музыка и саунд-эффекты.
        // У объекта Audio в скриптах нет метода play(), поэтому
        // проигрываем через Web Audio API: загрузили файл,
        // декодировали в буфер, запустили через BufferSource.
        // Путь указывается вместе с папкой и расширением,
        // как файл лежит в Project Bar.
        // ============================================================
        const MUSIC_TRACK = "music/mainTheme.ogg"; // поменяй на свой путь!
        const SFX_CLICK = "sounds/sfxClick.ogg";   // и здесь тоже
        const MUSIC_VOLUME = 0.4;
        const SFX_VOLUME = 0.8;

        const audioCtx = audioObj ? audioObj.audioContext : null;

        // Кеш декодированных буферов: каждый файл декодируем один раз.
        const audioBuffers = {};

        async function loadBuffer(filename) {
            if (audioBuffers[filename]) return audioBuffers[filename];

            // Получаем правильный URL файла проекта.
            const url = await runtime.assets.getProjectFileUrl(filename);
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);

            audioBuffers[filename] = buffer;
            return buffer;
        }

        async function playSound(filename, { loop = false, vol = 1 } = {}) {
            if (!audioObj) return;
            try {
                const buffer = await loadBuffer(filename);

                // Браузер может приостановить звуковой контекст —
                // возобновляем при первом взаимодействии пользователя.
                if (audioCtx.state === "suspended") {
                    await audioCtx.resume();
                }

                const source = audioCtx.createBufferSource();
                source.buffer = buffer;
                source.loop = loop;

                const gain = audioCtx.createGain();
                gain.gain.value = vol;

                source.connect(gain);
                gain.connect(audioObj.destinationNode);
                source.start();
            } catch (err) {
                console.error("Ошибка воспроизведения звука:", filename, err);
            }
        }

        // Запуск музыки по первому действию пользователя:
        // браузеры блокируют автозвук до первого клика.
        let musicStarted = false;

        function startMusicIfFirstClick() {
            if (musicStarted) return;
            musicStarted = true;
            playSound(MUSIC_TRACK, { loop: true, vol: MUSIC_VOLUME });
        }

        // Саунд-эффект нажатия.
        function playClickSfx() {
            playSound(SFX_CLICK, { vol: SFX_VOLUME });
        }

        function updateEnergyUI() {
            const energy = varManager.instVars.Energy;
            const energyString = String(energy);

            // Текст всегда показывает текущее значение Energy.
            if (energyText.text !== energyString) {
                energyText.text = energyString;
            }

            // Меняем шкалу только при изменении энергии.
            if (energy === lastDisplayedEnergy) return;
            lastDisplayedEnergy = energy;

            // Доля оставшейся энергии от 0 до 1.
            const ratio = Math.max(0, Math.min(1, energy / MAX_ENERGY));

            if (energySegments.length > 0) {
                // Сегментированный режим: сегменты гаснут по мере
                // опустошения шкалы.
                const litCount = Math.round(ratio * energySegments.length);

                energySegments.forEach((segment, index) => {
                    segment.isVisible = index < litCount;
                });

                // Старая заливка больше не нужна — её роль играют сегменты.
                energyBar.isVisible = false;
                // Подложка BG всегда видна как тёмный фон шкалы.
                if (energyBarBG) energyBarBG.isVisible = true;
            } else {
                // Запасной режим: если сегментов в проекте нет,
                // работает старая непрерывная шкала.
                energyBar.isVisible = ratio > 0;
            }
        }

        // Обновляем интерфейс сразу при запуске.
        updateEnergyUI();

        // Следим за изменением энергии от любых игровых механик.
        runtime.addEventListener("tick2", updateEnergyUI);

        // Первая кнопка расхода энергии.
        energyButton.addEventListener("click", () => {
            varManager.instVars.Energy = Math.max(0, varManager.instVars.Energy - 1);
            updateEnergyUI();
            startMusicIfFirstClick();
            playClickSfx();
        });

        // Вторая кнопка расхода энергии.
        energyButton2.addEventListener("click", () => {
            varManager.instVars.Energy = Math.max(0, varManager.instVars.Energy - 1);
            updateEnergyUI();
            startMusicIfFirstClick();
            playClickSfx();
        });

        // Третья кнопка расхода энергии.
        energyButton3.addEventListener("click", () => {
            varManager.instVars.Energy = Math.max(0, varManager.instVars.Energy - 1);
            updateEnergyUI();
            startMusicIfFirstClick();
            playClickSfx();
        });

        // ============================================================
        // Кнопка кофе: одноразовое полное восстановление энергии.
        // ============================================================
        let coffeeUsed = false;

        if (coffeeButton) {
            coffeeButton.addEventListener("click", () => {
                if (coffeeUsed) return;
                coffeeUsed = true;

                // Полное восстановление до максимума.
                varManager.instVars.Energy = MAX_ENERGY;
                updateEnergyUI();

                startMusicIfFirstClick();
                playClickSfx();

                // Прячем кнопку — кофе выпит, второго не будет.
                coffeeButton.isVisible = false;
            });
        }

        // Переключаем комнаты и двигаем камеру.
        changeFrameButton.addEventListener("click", () => {
            varManager.instVars.roomSelect = !varManager.instVars.roomSelect;
            cameraObj.x = varManager.instVars.roomSelect ? 2905 : 935;
            startMusicIfFirstClick();
            playClickSfx();
        });

        // ============================================================
        // Список-чеклист (как в That's Not My Neighbor).
        // Клики ловим вручную по координатам — не зависит от
        // свойства Input и от того, что лежит сверху.
        // ============================================================
        const listButton = runtime.objects.listButton.getFirstInstance();
        const listPanel = runtime.objects.listPanel.getFirstInstance();
        const listItem1 = runtime.objects.listItem1.getFirstInstance();
        const listItem2 = runtime.objects.listItem2.getFirstInstance();
        const listItem3 = runtime.objects.listItem3.getFirstInstance();

        // Панель и пункты скрыты до первого клика по иконке.
        listPanel.isVisible = false;
        listItem1.isVisible = false;
        listItem2.isVisible = false;
        listItem3.isVisible = false;

        // Проверка: попал ли указатель (в координатах окна)
        // в прямоугольник спрайта.
        function isPointerOver(instance, clientX, clientY) {
            const [lx, ly] = instance.layer.cssPxToLayer(clientX, clientY);
            const left = instance.x - instance.width * instance.originX;
            const right = instance.x + instance.width * (1 - instance.originX);
            const top = instance.y - instance.height * instance.originY;
            const bottom = instance.y + instance.height * (1 - instance.originY);
            return lx >= left && lx <= right && ly >= top && ly <= bottom;
        }

        // Переключение раскрытия списка.
        function toggleList() {
            const expanded = !listPanel.isVisible;
            listPanel.isVisible = expanded;
            listItem1.isVisible = expanded;
            listItem2.isVisible = expanded;
            listItem3.isVisible = expanded;
        }

        runtime.addEventListener("pointerdown", (e) => {
            // Сначала иконка списка — раскрыть/свернуть.
            if (isPointerOver(listButton, e.clientX, e.clientY)) {
                toggleList();
                startMusicIfFirstClick();
                playClickSfx();
                return;
            }

            // Потом пункты — только если список раскрыт.
            if (!listPanel.isVisible) return;

            const items = [listItem1, listItem2, listItem3];
            items.forEach((item) => {
                if (isPointerOver(item, e.clientX, e.clientY)) {
                    // Кадр 0 — пустая клетка, кадр 1 — с галочкой.
                    item.animationFrame = item.animationFrame === 0 ? 1 : 0;
                    startMusicIfFirstClick();
                    playClickSfx();
                }
            });
        });
    });
});
