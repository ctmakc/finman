// lib/money.js — безопасная денежная арифметика (2 знака после запятой)
// Все функции возвращают Number, округлённый до 2 знаков, устойчивый к float-дрейфу.

// Округление до 2 знаков, защита от float-погрешности (0.1 + 0.2 === 0.3).
// - Половина копейки округляется ОТ НУЛЯ симметрично для обоих знаков
//   (-1.005 -> -1.01, как и 1.005 -> 1.01): Math.round тянет -x.5 к +∞,
//   поэтому округляем модуль и возвращаем знак. -0 нормализуем в 0.
// - Значение в копейках сначала очищается от двоичного «шума» до 15 значащих
//   цифр: 1.005 * 100 = 100.49999999999999 -> 100.5, а 2592.315 (произведение
//   суммы на курс) уже не теряет копейку. Прежний трюк с Number.EPSILON
//   работал только для сумм около 1.
function round(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  const cents = Number((Math.abs(num) * 100).toPrecision(15));
  const abs = Math.round(cents) / 100;
  if (abs === 0) return 0;
  return num < 0 ? -abs : abs;
}

// Сложение произвольного числа аргументов
function add(...nums) {
  return round(nums.reduce((acc, n) => acc + Number(n || 0), 0));
}

// Вычитание a - b
function sub(a, b) {
  return round(Number(a || 0) - Number(b || 0));
}

// Умножение a * b
function mul(a, b) {
  return round(Number(a || 0) * Number(b || 0));
}

// Деление a / b (деление на 0 -> 0)
function div(a, b) {
  const divisor = Number(b);
  if (!divisor) return 0;
  return round(Number(a || 0) / divisor);
}

// Сумма массива чисел
function sum(arrOfNums) {
  if (!Array.isArray(arrOfNums)) return 0;
  return round(arrOfNums.reduce((acc, n) => acc + Number(n || 0), 0));
}

module.exports = { round, add, sub, mul, div, sum };
