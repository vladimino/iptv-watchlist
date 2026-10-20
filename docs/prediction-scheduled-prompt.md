# Scheduled prediction prompt — legacy Sites

Data cutover to Cloudflare finished on 19 October 2026. This prompt still targets the legacy Site and must stay disabled. Do not run it against the Site, and do not point it at the Cloudflare Worker until unattended Cloudflare authorization is separately verified. The Sites bypass token is not a Cloudflare credential. Do not relax Cloudflare Access to make the task work.

The historical prompt below is kept so the disabled task can be recognized. It is not permission to resume predictions. The replacement caller, once AIR-62 allows it, is the MCP tool allowlist in [docs/mcp.md](mcp.md). Do not put this prompt or any secret into a Scheduled Task.

Почасовые прогнозы «В эфире»: сохрани существующую Site-aware привязку и почасовое расписание Europe/Madrid.

В начале получи Sites get_site для связанного сайта. Используй current_live_url и siwc_bypass_bearer_token только для запросов к этому сайту; не сохраняй токен в output, URL или Events. Проверь GET /api/enrichment/runner, /api/enrichment/schema и /api/enrichment/profile. При отсутствии доступа уведомь с конкретной стадией сбоя без секретов.

Следуй текущему серверному runner contract как источнику истины. POST /api/enrichment/start: scope watchlist_all, mode queued, trigger scheduled, без фиксированного batchSize. Передавай capacity.remainingPercent только если знаешь фактическое значение. already_running — штатный успешный no-op: сразу заверши запуск и не присоединяйся к чужому runId. busy — временная блокировка записи: повтори запрос с небольшим backoff.

После получения собственного runId непрерывно повторяй next → генерация → submit каждого фильма сразу → next. Сервер выбирает adaptive batch и заново применяет urgent hot → hot → cold. Не завершай run после одного batch, не вводи лимит времени или общего количества фильмов. Переходи к следующему batch до пустой eligible очереди или реального внешнего ограничения. При каждом model call используй неизменные Taste Profile, fingerprint semantics и правила оценки. prediction_only переиспользует сохранённый fingerprint; актуальные прогнозы не пересчитываются. Не запрашивай actual rating целевого фильма. Совместный JSON-array model batching выключен.

POST /api/enrichment/heartbeat перед model call; при длительном call продлевай heartbeat параллельно каждые 10 минут. Submit сохраняет checkpoint и продлевает lease после каждого фильма. Если next/submit возвращает mustComplete, вызови complete со stopReason. При фактическом quota/model/API/storage error вызови complete с безопасной краткой причиной, когда возможно. Сохранённые результаты продолжит следующий trigger; умерший процесс освободит lease через TTL.

Успешный run silent. Ошибка уведомляет с конкретной стадией и причиной без секретов. Пользовательские промежуточные и финальные события пишет сервер; не создавай отдельные события на каждый batch.
