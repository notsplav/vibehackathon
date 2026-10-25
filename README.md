# Проверка утверждений в статьях

Chrome-расширение (Manifest V3) и локальный сервер. Расширение извлекает статью со страницы, сервер выделяет проверяемые утверждения и проверяет их по источникам: через Gemini API с поиском Google или через локальную модель Ollama с Ollama Web Search. Результаты отмечаются прямо в тексте статьи.

Техническое задание: [`tech.md`](tech.md). Принятые решения: [`docs/decisions.md`](docs/decisions.md). Правила работы в репозитории: [`CLAUDE.md`](CLAUDE.md).

## Быстрый старт

Нужны Node.js 24+ и Chrome 116+.

```sh
npm install
cp .env.example .env      # впишите свой GEMINI_API_KEY
npm run probe:gemini      # проверить ключ и доступ к Google Search
npm run dev:server        # сервер на http://127.0.0.1:8787
npm run build:extension   # сборка в extension/dist
```

### Вариант без Gemini: локальная модель Ollama

Модель работает на вашем компьютере, в интернет уходят только поисковые запросы (Ollama Web Search). Источники берутся из результатов поиска, а не из текста модели.

```sh
ollama serve                 # если Ollama ещё не запущена
ollama pull qwen3:14b        # около 9 ГБ
# в .env: LLM_PROVIDER=ollama и OLLAMA_API_KEY=<ключ с https://ollama.com/settings/keys>
npm run probe:ollama         # проверка модели и поиска
npm run dev:server
```

В Chrome откройте `chrome://extensions`, включите режим разработчика, нажмите «Загрузить распакованное расширение» и выберите `extension/dist`. Затем откройте статью и нажмите на значок расширения. В боковой панели запустите анализ.

ID расширения постоянный (`gpmhmgppcnmhmkiiaefegfiboaoagiao`): в manifest задан публичный ключ. Сервер по умолчанию принимает запросы только от этого ID.

## Тесты

```sh
npm test          # Vitest: извлечение (jsdom) и сервер (Node)
npm run typecheck
```

Эталонная статья Lenta.ru в репозиторий не входит. Как сохранить её локально, описано в [`fixtures/README.md`](fixtures/README.md).
