// repositories/contact.repository.js
const { query } = require("../../config/db.config"); 

class ContactRepository {
  /**
   * Inserts a new contact submission record into the PostgreSQL database.
   * Utilizes the custom query wrapper for execution logging and safety filters.
   */
  async create({ name, email, topic, budget, message }) {
    // We can pass a named query object to utilize the prepared statement cache!
    const queryConfig = {
      name: "insert-contact-submission",
      text: `
        INSERT INTO contacts (name, email, topic, budget, message)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, email, topic, budget, message, status, created_at;
      `
    };
    
    const values = [name, email, topic, budget || null, message];
    
    // Call the exported query function directly
    const result = await query(queryConfig, values);
    return result.rows[0];
  }

  /**
   * Retrieves submissions with pagination for admin internal tracking dashboards.
   */
  async findAll(limit = 10, offset = 0) {
    const queryConfig = {
      name: "get-paginated-contacts",
      text: `
        SELECT id, name, email, topic, budget, message, status, created_at
        FROM contacts
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2;
      `
    };

    const result = await query(queryConfig, [limit, offset]);
    return result.rows;
  }
}

module.exports = new ContactRepository();