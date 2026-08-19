const searchService = require('./search.service');
const searchLogger = require('./search.logger');

async function handleSearch(req, res, next) {
  console.log("👉 Search route successfully reached! Query:", req.validatedSearchQuery);
  const requestId = req.searchRequestId;
  const userId = req.user?.sub;
  const { q: queryText } = req.validatedSearchQuery;

  try {
    searchLogger.info(
      { requestId, userId, query: queryText },
      'request_received',
    );

    const rawResults = await searchService.executeGlobalSearch(
      userId,
      queryText,
      requestId,
    );

    
    // ✅ Guard: service may return null/undefined on no match
    const results = rawResults ?? [];

    return res.status(200).json({
      success: true,
      count: results.length,
      requestId,
      results,
    });
  } catch (error) {
    searchLogger.queryFailed({
      requestId,
      userId,
      query: queryText,
      error,
    });

    return next(error);
  }
}

module.exports = { handleSearch };
