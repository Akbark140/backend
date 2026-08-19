jest.mock('../../src/config/db.config', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/modules/ai/ai.gateway', () => ({
  call: jest.fn(),
  stream: jest.fn(),
  getCircuitStatus: jest.fn(),
}));

jest.mock('../../src/modules/ai/ai.cache', () => ({
  getCategorization: jest.fn(),
  setCategorization: jest.fn(),
  getInsights: jest.fn(),
  setInsights: jest.fn(),
  invalidateInsights: jest.fn(),
  getAnalysis: jest.fn(),
  setAnalysis: jest.fn(),
  getSuggestions: jest.fn(),
  setSuggestions: jest.fn(),
  invalidateSuggestions: jest.fn(),
  getReportMeta: jest.fn(),
  setReportMeta: jest.fn(),
}));

const { query } = require('../../src/config/db.config');
const aiService = require('../../src/modules/ai/ai.service');

describe('AI service history and calendar parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('round-trips chat history content without double encoding', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [{ id: 'msg-1', role: 'user', content: 'Hello there' }],
    });

    await aiService.saveChatMessage('user-1', 'user', 'Hello there');
    const history = await aiService.loadChatHistory('user-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chat_history'),
      ['user-1', 'user', 'Hello there'],
    );
    expect(history).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello there' }),
    ]);
  });

  it('parses ambiguous slash dates as day/month/year by default', () => {
    const result = aiService.parseCalendarDateTime('10/08/2029 10:00pm');

    expect(result).toMatchObject({
      isoString: '2029-08-10T22:00:00.000Z',
      displayText: expect.stringContaining('10 August 2029'),
    });
  });

  it('uses the next year for past dates when no year is provided', () => {
    const currentYear = new Date().getFullYear();
    const result = aiService.parseCalendarDateTime('10/08 10:00pm');

    expect(result.isoString).toBe(`${currentYear + 1}-08-10T22:00:00.000Z`);
  });

  it('groups monthly transactions by category and produces comparison deltas', () => {
    const transactions = [
      { type: 'expense', description: 'Groceries', category: 'Food', amount: '50', date: '2024-06-01T10:00:00Z' },
      { type: 'expense', description: 'Taxi', category: 'Transport', amount: '20', date: '2024-06-15T10:00:00Z' },
      { type: 'income', description: 'Salary', category: 'Income', amount: '2000', date: '2024-07-01T10:00:00Z' },
      { type: 'expense', description: 'Dinner', category: 'Food', amount: '60', date: '2024-07-02T10:00:00Z' },
    ];

    const result = aiService.buildCategorizedSummary(transactions, [{ year: 2024, month: 6 }, { year: 2024, month: 7 }]);

    expect(result.months).toHaveLength(2);
    expect(result.months[0].totals).toMatchObject({ income: 0, expense: 70, net: -70 });
    expect(result.months[1].totals).toMatchObject({ income: 2000, expense: 60, net: 1940 });
    expect(result.comparison.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Food', delta: 10, direction: 'increase' }),
      ]),
    );
    expect(result.comparison.totalExpenseDelta).toBe(-10);
  });

  it('flags likely duplicate transactions that happen close together', () => {
    const transactions = [
      { type: 'expense', description: 'Olive Garden', category: 'Dining', amount: '85.20', date: '2024-06-01T10:00:00Z' },
      { type: 'expense', description: 'Olive Garden', category: 'Dining', amount: '85.20', date: '2024-06-01T11:00:00Z' },
      { type: 'expense', description: 'Subscription', category: 'Utilities', amount: '10.00', date: '2024-06-01T10:00:00Z' },
      { type: 'expense', description: 'Subscription', category: 'Utilities', amount: '10.00', date: '2024-07-01T10:00:00Z' },
    ];

    const result = aiService.buildCategorizedSummary(transactions, [{ year: 2024, month: 6 }]);

    expect(result.possibleDuplicates).toHaveLength(1);
    expect(result.possibleDuplicates[0]).toMatchObject({ description: 'Olive Garden', amount: 85.2 });
  });
});
