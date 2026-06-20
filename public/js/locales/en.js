// English locale dictionary for FINMAN.
// Registered onto window.FINMAN_LOCALES.en so i18n.js can resolve keys.
// Keys are dotted (nav.*, btn.*, common.*, ...). i18n.js supports both
// flat-dotted and nested dictionaries; we use flat-dotted here for clarity.
(function (root) {
  'use strict';
  var dict = {
    // ---- app ----
    'app.name': 'FinManager',
    'app.tagline': 'Personal finance manager',
    'app.loading': 'Loading application...',

    // ---- navigation ----
    'nav.dashboard': 'Dashboard',
    'nav.accounts': 'Accounts',
    'nav.transactions': 'Transactions',
    'nav.budgets': 'Budgets',
    'nav.goals': 'Goals',
    'nav.debts': 'Debts',
    'nav.investments': 'Investments',
    'nav.analytics': 'Analytics',
    'nav.reports': 'Reports',
    'nav.subscriptions': 'Subscriptions',
    'nav.networth': 'Net Worth',
    'nav.receipts': 'Receipts',
    'nav.calendar': 'Calendar',
    'nav.forecast': 'Forecast',
    'nav.family': 'Family',
    'nav.recurring': 'Recurring',
    'nav.settings': 'Settings',
    'nav.assistant': 'AI Assistant',

    // ---- buttons / actions ----
    'btn.add': 'Add',
    'btn.create': 'Create',
    'btn.save': 'Save',
    'btn.edit': 'Edit',
    'btn.delete': 'Delete',
    'btn.cancel': 'Cancel',
    'btn.close': 'Close',
    'btn.confirm': 'Confirm',
    'btn.back': 'Back',
    'btn.next': 'Next',
    'btn.search': 'Search',
    'btn.filter': 'Filter',
    'btn.export': 'Export',
    'btn.import': 'Import',
    'btn.refresh': 'Refresh',
    'btn.upgrade': 'Upgrade',
    'btn.login': 'Log in',
    'btn.logout': 'Log out',
    'btn.register': 'Sign up',

    // ---- common labels ----
    'common.name': 'Name',
    'common.amount': 'Amount',
    'common.currency': 'Currency',
    'common.date': 'Date',
    'common.category': 'Category',
    'common.description': 'Description',
    'common.type': 'Type',
    'common.status': 'Status',
    'common.balance': 'Balance',
    'common.total': 'Total',
    'common.income': 'Income',
    'common.expense': 'Expense',
    'common.from': 'From',
    'common.to': 'To',
    'common.actions': 'Actions',
    'common.optional': 'Optional',
    'common.required': 'Required',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.all': 'All',
    'common.none': 'None',
    'common.loading': 'Loading...',
    'common.saving': 'Saving...',
    'common.empty': 'No data',
    'common.email': 'Email',
    'common.password': 'Password',
    'common.fullName': 'Full name',
    'common.progress': 'Progress',
    'common.remaining': 'Remaining',
    'common.target': 'Target',

    // ---- messages ----
    'msg.saved': 'Saved successfully',
    'msg.deleted': 'Deleted',
    'msg.created': 'Created',
    'msg.updated': 'Updated',
    'msg.error': 'An error occurred',
    'msg.loadError': 'Failed to load data',
    'msg.confirmDelete': 'Delete this item?',
    'msg.unauthorized': 'Not authorized',
    'msg.notConfigured': 'Not configured',
    'msg.greeting': 'Hello, {name}!',
    'msg.itemsCount': '{count} items'
  };

  root.FINMAN_LOCALES = root.FINMAN_LOCALES || {};
  root.FINMAN_LOCALES.en = dict;

  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
