const { query, get, run } = require('../db/database');

// Список поддерживаемых валют
const SUPPORTED_CURRENCIES = [
  { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'PLN', name: 'Polish Zloty', symbol: 'zł' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺' },
  { code: 'ILS', name: 'Israeli Shekel', symbol: '₪' },
  { code: 'BTC', name: 'Bitcoin', symbol: '₿' }
];

class Currency {
  // Получить список поддерживаемых валют
  static getSupportedCurrencies() {
    return SUPPORTED_CURRENCIES;
  }

  // Получить информацию о валюте
  static getCurrencyInfo(code) {
    return SUPPORTED_CURRENCIES.find(c => c.code === code.toUpperCase());
  }

  // Сохранить курс валюты
  static async saveRate(fromCurrency, toCurrency, rate, source = 'manual', date = null) {
    const rateDate = date || new Date().toISOString().split('T')[0];

    try {
      await run(
        `INSERT OR REPLACE INTO currency_rates (from_currency, to_currency, rate, source, date)
         VALUES (?, ?, ?, ?, ?)`,
        [fromCurrency.toUpperCase(), toCurrency.toUpperCase(), rate, source, rateDate]
      );
      return true;
    } catch (error) {
      console.error('Error saving exchange rate:', error);
      return false;
    }
  }

  // Получить курс валюты
  static async getRate(fromCurrency, toCurrency, date = null) {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) return 1;

    const rateDate = date || new Date().toISOString().split('T')[0];

    // Сначала ищем прямой курс
    let rate = await get(
      `SELECT rate FROM currency_rates
       WHERE from_currency = ? AND to_currency = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
      [from, to, rateDate]
    );

    if (rate) return rate.rate;

    // Ищем обратный курс
    rate = await get(
      `SELECT rate FROM currency_rates
       WHERE from_currency = ? AND to_currency = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
      [to, from, rateDate]
    );

    if (rate) return 1 / rate.rate;

    // Пробуем через USD как промежуточную валюту
    if (from !== 'USD' && to !== 'USD') {
      const rateToUsd = await this.getRate(from, 'USD', rateDate);
      const rateFromUsd = await this.getRate('USD', to, rateDate);

      if (rateToUsd && rateFromUsd) {
        return rateToUsd * rateFromUsd;
      }
    }

    return null;
  }

  // Конвертировать сумму
  static async convert(amount, fromCurrency, toCurrency, date = null) {
    const rate = await this.getRate(fromCurrency, toCurrency, date);

    if (rate === null) {
      return { success: false, message: 'Exchange rate not found' };
    }

    return {
      success: true,
      amount: amount * rate,
      rate,
      fromCurrency,
      toCurrency
    };
  }

  // Получить все курсы для валюты
  static async getRatesForCurrency(baseCurrency, targetCurrencies = null) {
    const base = baseCurrency.toUpperCase();
    const targets = targetCurrencies || SUPPORTED_CURRENCIES.map(c => c.code).filter(c => c !== base);

    const rates = {};
    for (const target of targets) {
      const rate = await this.getRate(base, target);
      if (rate) {
        rates[target] = rate;
      }
    }

    return rates;
  }

  // Обновить курсы с внешнего API (НБУ для UAH)
  static async fetchRatesFromNBU() {
    try {
      const https = require('https');

      const response = await new Promise((resolve, reject) => {
        https.get('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
          res.on('error', reject);
        }).on('error', reject);
      });

      const today = new Date().toISOString().split('T')[0];
      let saved = 0;

      for (const item of response) {
        const currencyCode = item.cc;
        const rate = item.rate;

        // Сохраняем курс к гривне
        if (SUPPORTED_CURRENCIES.some(c => c.code === currencyCode)) {
          await this.saveRate(currencyCode, 'UAH', rate, 'nbu', today);
          saved++;
        }
      }

      return { success: true, saved, source: 'NBU' };
    } catch (error) {
      console.error('Error fetching NBU rates:', error);
      return { success: false, error: error.message };
    }
  }

  // Обновить курсы с exchangerate.host (бесплатный API)
  static async fetchRatesFromExchangeRate(baseCurrency = 'USD') {
    try {
      const https = require('https');

      const response = await new Promise((resolve, reject) => {
        const url = `https://api.exchangerate.host/latest?base=${baseCurrency}`;
        https.get(url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      if (!response.success && !response.rates) {
        return { success: false, error: 'Invalid response' };
      }

      const today = new Date().toISOString().split('T')[0];
      let saved = 0;

      const rates = response.rates || response;
      for (const [code, rate] of Object.entries(rates)) {
        if (SUPPORTED_CURRENCIES.some(c => c.code === code) && typeof rate === 'number') {
          await this.saveRate(baseCurrency, code, rate, 'exchangerate', today);
          saved++;
        }
      }

      return { success: true, saved, source: 'exchangerate.host' };
    } catch (error) {
      console.error('Error fetching rates:', error);
      return { success: false, error: error.message };
    }
  }

  // Получить историю курсов
  static async getRateHistory(fromCurrency, toCurrency, days = 30) {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    return query(
      `SELECT date, rate FROM currency_rates
       WHERE from_currency = ? AND to_currency = ?
       ORDER BY date DESC LIMIT ?`,
      [from, to, days]
    );
  }

  // Получить настройки валют пользователя
  static async getUserSettings(userId) {
    let settings = await get(
      `SELECT * FROM user_currency_settings WHERE user_id = ?`,
      [userId]
    );

    if (!settings) {
      // Создаем настройки по умолчанию
      await run(
        `INSERT INTO user_currency_settings (user_id, base_currency, display_currencies)
         VALUES (?, 'UAH', '["UAH","USD","EUR"]')`,
        [userId]
      );
      settings = await get(
        `SELECT * FROM user_currency_settings WHERE user_id = ?`,
        [userId]
      );
    }

    return {
      ...settings,
      display_currencies: JSON.parse(settings.display_currencies || '["UAH","USD","EUR"]')
    };
  }

  // Обновить настройки валют пользователя
  static async updateUserSettings(userId, settings) {
    const { baseCurrency, displayCurrencies, autoConvert } = settings;

    const fields = [];
    const values = [];

    if (baseCurrency) {
      fields.push('base_currency = ?');
      values.push(baseCurrency.toUpperCase());
    }
    if (displayCurrencies) {
      fields.push('display_currencies = ?');
      values.push(JSON.stringify(displayCurrencies));
    }
    if (autoConvert !== undefined) {
      fields.push('auto_convert = ?');
      values.push(autoConvert ? 1 : 0);
    }

    if (fields.length === 0) return true;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);

    await run(
      `UPDATE user_currency_settings SET ${fields.join(', ')} WHERE user_id = ?`,
      values
    );

    return true;
  }

  // Рассчитать общий баланс в базовой валюте
  static async calculateTotalBalance(userId, accounts, baseCurrency = 'UAH') {
    let total = 0;

    for (const account of accounts) {
      if (account.currency === baseCurrency) {
        total += account.balance;
      } else {
        const converted = await this.convert(account.balance, account.currency, baseCurrency);
        if (converted.success) {
          total += converted.amount;
        }
      }
    }

    return { total, currency: baseCurrency };
  }
}

module.exports = Currency;
