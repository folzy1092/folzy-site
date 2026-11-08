// Настройки сайта. Подключается синхронно в <head>, поэтому класс .js ставится до первой отрисовки
// и блоки с .reveal не мигают.
document.documentElement.classList.add('js');

window.FOLZY = {
  // Адрес воркера из worker/ после `npx wrangler deploy`, например 'https://folzy-music.<имя>.workers.dev'.
  // Пусто — блок музыки честно пишет, что endpoint не подключён. Для превью вёрстки: ?demo в адресе.
  musicEndpoint: '',
  timezone: 'Europe/Riga',
  nowEvery: 10,        // секунд между запросами «сейчас играет» (трек меняет бот, ответ воркера — мгновенный)
  statsEvery: 300,     // секунд между запросами статистики
};
