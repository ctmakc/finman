// jest.config.js — Foundation test harness config.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  // Тесты делят SQLite-файлы; гоняем последовательно (см. также npm script --runInBand).
  maxWorkers: 1,
  testTimeout: 30000,
  // Не считаем покрытие по умолчанию; feature-стримы могут включить.
  collectCoverage: false,
  verbose: false,
  // tesseract.js (OCR) спавнит worker'ы, которые не всегда завершаются к концу
  // прогона и держат event loop -> jest висел после "X passed". Тесты проходят;
  // forceExit гарантирует чистый выход.
  forceExit: true,
};
