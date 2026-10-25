# Сверка

Проверка утверждений в статьях.

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

### Вариант без Gemini: локальная модель Ollama и SearXNG

Модель работает на вашем компьютере. Источники ищет локальный метапоиск SearXNG в Docker: ключи и лимиты API не нужны. Ссылки для вердиктов берутся только из результатов поиска, а не из текста модели.

```sh
brew install --cask orbstack   # Docker, если его ещё нет; затем откройте OrbStack
ollama serve                   # если Ollama ещё не запущена
ollama pull qwen3:14b          # около 9 ГБ
npm run searxng:up             # SearXNG на http://127.0.0.1:8888
# в .env: LLM_PROVIDER=ollama
npm run probe:ollama           # проверка модели и поиска
npm run dev:server
```

Поисковые запросы (2 на утверждение, `SEARCH_QUERIES_PER_CLAIM`) модель составляет сразу при извлечении утверждений, поэтому на проверку утверждения уходит один вызов модели (вердикт), а запросы ищутся параллельно. Если запросов нет (например, анализ начат до обновления), модель составит их отдельным вызовом. Одинаковые утверждения, уже проверенные той же моделью за последние 24 часа, повторно не проверяются; «Повторить анализ» проверяет заново. Вместо SearXNG можно использовать Ollama Web Search: `SEARCH_PROVIDER=ollama` и `OLLAMA_API_KEY`.

В Chrome откройте `chrome://extensions`, включите режим разработчика, нажмите «Загрузить распакованное расширение» и выберите `extension/dist`. Затем откройте статью и нажмите на значок расширения. В боковой панели нажмите «Начать проверку».

ID расширения постоянный (`gpmhmgppcnmhmkiiaefegfiboaoagiao`): в manifest задан публичный ключ. Сервер по умолчанию принимает запросы только от этого ID.

## Тесты

```sh
npm test          # Vitest: извлечение (jsdom) и сервер (Node)
npm run typecheck
```

Эталонная статья Lenta.ru в репозиторий не входит. Как сохранить её локально, описано в [`fixtures/README.md`](fixtures/README.md).


Ссылки на наши сайты для проверки:
1. https://notsplav.github.io/vibehackathon/   - полностью достоверная
2. https://notsplav.github.io/vibehackathon/index2   - есть неточности
3. https://notsplav.github.io/vibehackathon/index3   - ии фейк
