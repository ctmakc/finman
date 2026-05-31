const fs = require('fs');
const { promisify } = require('util');
const readFileAsync = promisify(fs.readFile);

/**
 * Сервис для импорта транзакций из CSV-файлов
 */
class CsvImportService {
  /**
   * Обработка CSV-файла и преобразование в массив транзакций
   */
  async processCSVFile(filePath, options) {
    try {
      const { userId, accountId, bankType = 'generic' } = options;
      
      // Чтение файла
      const data = await readFileAsync(filePath, 'utf8');
      
      // Разбор CSV
      const lines = data.split('\n');
      if (lines.length <= 1) {
        throw new Error('Файл пуст или содержит только заголовки');
      }
      
      // Получение заголовков
      const headers = this.parseCSVLine(lines[0]);
      
      // Обработка строк
      const transactions = [];
      
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        // Разбор строки
        const values = this.parseCSVLine(lines[i]);
        
        // Создание объекта из строки
        const row = {};
        for (let j = 0; j < headers.length; j++) {
          row[headers[j]] = values[j] || '';
        }
        
        // Обработка в зависимости от типа банка
        const transaction = this.processTransaction(row, bankType);
        
        if (transaction.date && transaction.amount !== undefined) {
          transactions.push({
            ...transaction,
            accountId,
            userId
          });
        }
      }
      
      return transactions;
    } catch (error) {
      throw new Error(`Ошибка при обработке CSV-файла: ${error.message}`);
    }
  }
  
  /**
   * Разбор строки CSV с учетом кавычек
   */
  parseCSVLine(line) {
    const values = [];
    let currentValue = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        // Если встретили экранированную кавычку внутри строки
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          currentValue += '"';
          i++; // Пропускаем следующую кавычку
        } else {
          // Переключаем состояние
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Конец значения
        values.push(currentValue.trim());
        currentValue = '';
      } else {
        // Добавляем символ к текущему значению
        currentValue += char;
      }
    }
    
    // Добавляем последнее значение
    values.push(currentValue.trim());
    
    return values;
  }
  
  /**
   * Обработка транзакции в зависимости от типа банка
   */
  processTransaction(row, bankType) {
    let transaction = {};
    
    if (bankType === 'sberbank') {
      // Обработка для Сбербанка
      transaction = {
        date: this.parseDate(row['Дата операции'] || row['Дата'] || ''),
        description: row['Описание'] || row['Назначение платежа'] || '',
        amount: this.parseAmount(row['Сумма'] || row['Сумма операции'] || '0'),
        category: this.categorizeTransaction(row['Описание'] || row['Назначение платежа'] || '')
      };
    } else if (bankType === 'tinkoff') {
      // Обработка для Тинькофф
      transaction = {
        date: this.parseDate(row['Дата операции'] || row['Дата'] || ''),
        description: row['Описание'] || row['Назначение платежа'] || '',
        amount: this.parseAmount(row['Сумма платежа'] || row['Сумма операции'] || '0'),
        category: row['Категория'] || this.categorizeTransaction(row['Описание'] || '')
      };
    } else if (bankType === 'vtb') {
      // Обработка для ВТБ
      transaction = {
        date: this.parseDate(row['Дата операции'] || row['Дата'] || ''),
        description: row['Описание'] || row['Назначение платежа'] || '',
        amount: this.parseAmount(row['Сумма операции'] || row['Сумма'] || '0'),
        category: this.categorizeTransaction(row['Описание'] || '')
      };
    } else if (bankType === 'alfabank') {
      // Обработка для Альфа-Банка
      transaction = {
        date: this.parseDate(row['Дата операции'] || row['Дата'] || ''),
        description: row['Описание'] || row['Назначение платежа'] || '',
        amount: this.parseAmount(row['Сумма'] || '0'),
        category: this.categorizeTransaction(row['Описание'] || '')
      };
    } else {
      // Общий формат - попытка определить поля автоматически
      const dateKey = this.findKey(Object.keys(row), ['date', 'дата', 'дата операции']);
      const amountKey = this.findKey(Object.keys(row), ['amount', 'сумма', 'сумма операции']);
      const descKey = this.findKey(Object.keys(row), ['description', 'описание', 'назначение']);
      
      if (dateKey && amountKey) {
        transaction = {
          date: this.parseDate(row[dateKey] || ''),
          description: row[descKey] || '',
          amount: this.parseAmount(row[amountKey] || '0'),
          category: this.categorizeTransaction(row[descKey] || '')
        };
      }
    }
    
    // Добавление типа (доход/расход)
    if (Object.keys(transaction).length > 0) {
      transaction.type = transaction.amount >= 0 ? 'income' : 'expense';
    }
    
    return transaction;
  }
  
  /**
   * Поиск ключа в массиве по возможным именам
   */
  findKey(headers, possibleNames) {
    for (const name of possibleNames) {
      const key = headers.find(h => h.toLowerCase().includes(name.toLowerCase()));
      if (key) return key;
    }
    return null;
  }
  
  /**
   * Парсинг даты из разных форматов
   */
  parseDate(dateStr) {
    dateStr = dateStr.toString().trim();
    
    // DD.MM.YYYY
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
      const [day, month, year] = dateStr.split('.');
      return `${year}-${month}-${day}`;
    }
    
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }
    
    // DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const [day, month, year] = dateStr.split('/');
      return `${year}-${month}-${day}`;
    }
    
    return dateStr;
  }
  
  /**
   * Парсинг суммы из строки
   */
  parseAmount(amountStr) {
    // Удаление пробелов, замена запятой на точку
    let amount = amountStr.toString().replace(/\s/g, '').replace(',', '.');
    // Удаление символов валют и других нечисловых символов
    amount = amount.replace(/[^\d.-]/g, '');
    return parseFloat(amount) || 0;
  }
  
  /**
   * Категоризация транзакций по описанию
   */
  categorizeTransaction(description) {
    if (!description) return 'Другое';
    
    description = description.toLowerCase();
    
    // Расходы
    if (description.includes('кафе') || description.includes('ресторан') || 
        description.includes('кофе') || description.includes('пицца') ||
        description.includes('бургер') || description.includes('еда')) {
      return 'Рестораны';
    }
    
    if (description.includes('супермаркет') || description.includes('продукты') || 
        description.includes('магазин') || description.includes('market') || 
        description.includes('пятерочка') || description.includes('перекресток') || 
        description.includes('магнит') || description.includes('ашан') || 
        description.includes('лента')) {
      return 'Продукты';
    }
    
    if (description.includes('такси') || description.includes('uber') || 
        description.includes('метро') || description.includes('автобус') || 
        description.includes('транспорт')) {
      return 'Транспорт';
    }
    
    if (description.includes('аптека') || description.includes('clinic') || 
        description.includes('больниц') || description.includes('врач') || 
        description.includes('доктор')) {
      return 'Здоровье';
    }
    
    if (description.includes('одежда') || description.includes('обувь') || 
        description.includes('zara') || description.includes('h&m')) {
      return 'Одежда';
    }
    
    if (description.includes('кино') || description.includes('театр') || 
        description.includes('концерт') || description.includes('развлечения')) {
      return 'Развлечения';
    }
    
    if (description.includes('комиссия') || description.includes('плата за обслуживание')) {
      return 'Банковские услуги';
    }
    
    if (description.includes('подписка') || description.includes('subscription')) {
      return 'Подписки';
    }
    
    // Доходы
    if (description.includes('зарплата') || description.includes('аванс') || 
        description.includes('salary')) {
      return 'Зарплата';
    }
    
    if (description.includes('дивиденд') || description.includes('процент') || 
        description.includes('вклад')) {
      return 'Инвестиции';
    }
    
    if (description.includes('возврат') || description.includes('refund')) {
      return 'Возврат средств';
    }
    
    if (description.includes('перевод') || description.includes('transfer')) {
      return 'Переводы';
    }
    
    // По умолчанию
    return description.includes('перевод') ? 'Переводы' : 
           (description.includes('зачисление') ? 'Прочие доходы' : 'Прочие расходы');
  }
}

module.exports = new CsvImportService();