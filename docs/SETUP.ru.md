# Grok Voice на iPhone — настройка (интерфейс iPhone на английском)

## Safari (рекомендуется)
1. Откройте в Safari https://erik-balfe.github.io/voice-input-web/ → **Share** → **Add to Home Screen** → включите **Open as Web App** → **Add**. Запускайте с иконки.
2. В приложении: Настройки → «Войти через xAI» → «Открыть xAI» → подтвердите код → вернитесь.
3. Микрофон:
   - **Settings > Apps > Safari > Microphone > Allow** (для всех сайтов);
   - в Safari на странице: **aA > Website Settings > Microphone > Allow**.
   Веб-приложение с экрана «Домой» может всё равно спрашивать доступ после перезапуска (так устроен WebKit).
4. Модель чистки и «effort» видны в Настройках; под результатом и в Истории написано, какая модель использовалась. Версия приложения — внизу Настроек.

## Быстрый запуск (Shortcuts)
**Shortcuts** app → **+** → **Add Action** → **Open URLs** → `https://erik-balfe.github.io/voice-input-web/?autostart=1` (или `webapp://…` — см. ниже).
- **Settings > Action Button** → свайпом выберите **Shortcut** → выберите команду.
- **Settings > Accessibility > Touch > Back Tap > Double Tap** (или **Triple Tap**) → команда.

`?autostart=1`: если iOS разрешает микрофон без касания — запись начнётся сама; иначе кнопка подсветится — нажмите её. Обойти это требование iOS нельзя.

## Brave
- В Brave для iOS нет **Add to Home Screen** (запрос открыт с 2023 г.). Brave хранит вход и историю отдельно от Safari — войдите заново.
- Команда: **Shortcuts > + > Open URLs** → `brave://open-url?url=https%3A%2F%2Ferik-balfe.github.io%2Fvoice-input-web%2F%3Fautostart%3D1`
  → **⋯/Share > Add to Home Screen**, чтобы получить иконку.
- Или: сделать Brave браузером по умолчанию (**Settings > Apps > Brave > Default Browser App > Brave**) — тогда **Open URLs** с https-ссылкой откроет Brave.
