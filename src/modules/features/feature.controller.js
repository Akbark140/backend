const db = require('../../config/db.config'); // Your database connection pool

// GET /api/features - Public route for the frontend page
const getFeatures = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM upcoming_features ORDER BY progress DESC, created_at DESC');
    res.status(200).json({ data: result.rows });
  } catch (err) {
    console.error('Fetch features error:', err.message);
    res.status(500).json({ error: 'Failed to fetch roadmap features.' });
  }
};

// POST /api/features - Admin Only route to add/edit features
const upsertFeature = async (req, res) => {
  const { id, title, category, description, status, progress, icon } = req.body;

  if (!title || !status || progress === undefined) {
    return res.status(400).json({ error: 'Title, status, and progress are required.' });
  }

  try {
    if (id) {
      // Update existing feature
      const query = `
        UPDATE upcoming_features 
        SET title = $1, category = $2, description = $3, status = $4, progress = $5, icon = $6, updated_at = NOW()
        WHERE id = $7 RETURNING *`;
      const result = await db.query(query, [title, category, description, status, progress, icon, id]);
      return res.status(200).json({ message: 'Feature updated.', data: result.rows[0] });
    } else {
      // Insert new feature
      const query = `
        INSERT INTO upcoming_features (title, category, description, status, progress, icon)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
      const result = await db.query(query, [title, category, description, status, progress, icon]);
      return res.status(201).json({ message: 'Feature added.', data: result.rows[0] });
    }
  } catch (err) {
    console.error('Upsert feature error:', err.message);
    res.status(500).json({ error: 'Database save operation failed.' });
  }
};

module.exports = { getFeatures, upsertFeature };