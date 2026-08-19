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

jest.mock('../../src/config/index.config', () => ({
  config: { PORT: 3000 },
}));

jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn() },
    calendar: jest.fn(),
  },
}));

jest.mock('../../src/modules/ai/ai.service', () => ({
  chatService: jest.fn(),
  loadChatHistory: jest.fn(),
  saveChatMessage: jest.fn(),
  buildCategorizedSummary: jest.fn(),
}));

jest.mock('../../src/modules/transactions/transactions.service', () => ({
  list: jest.fn(),
}));

jest.mock('../../src/modules/budgets/budget.service', () => ({
  list: jest.fn(),
}));

jest.mock('../../src/modules/ai/ai.cache', () => ({
  getCategorizedSummary: jest.fn(),
  setCategorizedSummary: jest.fn(),
}));

const aiController = require('../../src/modules/ai/ai.controller');
const aiService = require('../../src/modules/ai/ai.service');
const transactionService = require('../../src/modules/transactions/transactions.service');
const aiCache = require('../../src/modules/ai/ai.cache');

describe('AI controller categorized summary tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches month-scoped transactions and returns a structured summary payload', async () => {
    const req = {
      body: { message: 'Show my spending for June', history: [] },
      user: { id: 'user-1' },
    };

    const res = {
      headersSent: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    };

    const next = jest.fn();

    aiService.loadChatHistory.mockResolvedValue([]);
    transactionService.list.mockResolvedValue({ data: [{ type: 'expense', description: 'Groceries', amount: '50', date: '2024-06-01T00:00:00Z' }] });
    aiService.buildCategorizedSummary.mockReturnValue({ months: [{ label: 'June 2024' }], comparison: null });
    aiCache.getCategorizedSummary.mockResolvedValue(null);
    aiCache.setCategorizedSummary.mockResolvedValue();

    aiService.chatService.mockImplementation(async ({ res: chatRes }) => {
      chatRes.json({
        success: true,
        triggerCategorizedSummary: true,
        months: [{ year: 2024, month: 6 }],
      });
    });

    await aiController.chat(req, res, next);

    expect(transactionService.list).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ startDate: expect.any(Date), endDate: expect.any(Date), limit: 1000 }),
    );
    expect(aiService.buildCategorizedSummary).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      triggerCategorizedSummary: true,
      summary: expect.any(Object),
    }));
  });
});
