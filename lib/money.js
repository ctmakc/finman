// lib/money.js — безопасная денежная арифметика (2 знака после запятой)
// Все функции возвращают Number, округлённый до 2 знаков, устойчивый к float-дрейфу.

// Округление до 2 знаков, защита от float-погрешности (0.1 + 0.2 === 0.3)
function round(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
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
