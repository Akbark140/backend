const { pool } = require('./src/config/db.config');

async function test() {
  try {
    const res = await pool.query(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY enum_name, e.enumsortorder
    `);
    
    const enums = {};
    res.rows.forEach(r => {
      if (!enums[r.enum_name]) {
        enums[r.enum_name] = [];
      }
      enums[r.enum_name].push(r.enum_value);
    });

    console.log('Database Custom Enum Types and Values:');
    console.log(JSON.stringify(enums, null, 2));
  } catch (err) {
    console.error('Error querying enums:', err);
  } finally {
    await pool.end();
  }
}

test();
