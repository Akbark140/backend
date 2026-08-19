const fs = require('fs');
const path = require('path');

class RuleEngine {
  constructor() {
    this.rulesCache = new Map();
  }

  /**
   * Dynamically loads tax rules for a specific jurisdiction and year.
   * Caches the rules in memory to optimize subsequent lookups.
   * 
   * @param {string} jurisdiction - The tax jurisdiction (e.g., "PAKISTAN")
   * @param {number} taxYear - The tax year (e.g., 2026)
   * @returns {Object} The tax rules configuration object
   */
  getRules(jurisdiction, taxYear) {
    const key = `${jurisdiction.toLowerCase()}_${taxYear}`;
    
    if (this.rulesCache.has(key)) {
      return this.rulesCache.get(key);
    }

    try {
      // Build file path for the rule config
      const ruleFilePath = path.join(__dirname, 'rules', `${key}.json`);
      
      // Load rule config synchronously (only happens once per rule set due to caching)
      const rawData = fs.readFileSync(ruleFilePath, 'utf8');
      const rules = JSON.parse(rawData);
      
      this.rulesCache.set(key, rules);
      return rules;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Tax rules not found for jurisdiction ${jurisdiction} and year ${taxYear}`);
      }
      throw new Error(`Failed to parse tax rules for ${jurisdiction} ${taxYear}: ${error.message}`);
    }
  }
}

// Export as singleton for application-wide use
module.exports = new RuleEngine();
