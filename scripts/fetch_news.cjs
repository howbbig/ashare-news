const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Referer': 'https://www.cls.cn/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 30000 // 30 second timeout
    };
    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON Parse Error: ${e.message} for ${url}`));
        }
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request Timeout for ${url}`));
    });
    
    req.on('error', (e) => {
      reject(new Error(`${e.message} for ${url}`));
    });
  });
}

function generateSign(params) {
  const sortedKeys = Object.keys(params).sort();
  const params_str = sortedKeys.map(k => k + '=' + params[k]).join('&');
  const sha1 = crypto.createHash('sha1').update(params_str).digest('hex');
  return crypto.createHash('md5').update(sha1).digest('hex');
}

function parseShanghaiTime(str) {
  const match = str.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (!match) return null;
  const [_, y, m, d, h, min, s] = match;
  const isoStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}+08:00`;
  const date = new Date(isoStr);
  return isNaN(date.getTime()) ? null : date;
}

async function fetchIndex(secid) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f58,f43,f169,f170,f59`;
  const response = await fetchJSON(url);
  if (response && response.data) {
    const d = response.data;
    const divisor = Math.pow(10, d.f59 || 2);
    const price = (d.f43 / divisor).toFixed(d.f59 || 2);
    const change = (d.f169 / divisor).toFixed(d.f59 || 2);
    const pct = (d.f170 / 100).toFixed(2);
    const sign = d.f169 > 0 ? '+' : '';
    return `${d.f58}: ${price} (${sign}${change} ${sign}${pct}%)`;
  }
  return null;
}

async function main() {
  try {
    // Fetch Indices (Non-fatal)
    let validIndices = [];
    try {
      const indices = await Promise.all([
        fetchIndex('1.000001'), // 上证指数
        fetchIndex('0.399001'), // 深证成指
        fetchIndex('0.399006')  // 创业板指
      ]);
      validIndices = indices.filter(i => i !== null);
    } catch (indexError) {
      console.warn("Warning: Could not fetch indices:", indexError.message);
    }

    // Calculate 8:00 AM today in Shanghai timezone as fallback
    const now = new Date();
    const today8AM = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    today8AM.setHours(8, 0, 0, 0);
    let startTimestamp = Math.floor(today8AM.getTime() / 1000);
    let lastFetchTimeStr = null;

    const targetFile = path.resolve(process.env.ASHARE_NEWS_FILE || path.join(__dirname, '..', 'ashare_news.md'));
    if (fs.existsSync(targetFile)) {
      const content = fs.readFileSync(targetFile, 'utf8');
      const match = content.match(/> Skill executed at:\s*([^\n(]+)/);
      if (match) {
        const parsedDate = parseShanghaiTime(match[1]);
        if (parsedDate) {
          startTimestamp = Math.floor(parsedDate.getTime() / 1000);
          lastFetchTimeStr = match[1].trim();
        }
      }
    }

    const uniqueNews = [];
    const seenCtimes = new Set();
    
    let lastTime = Math.floor(now.getTime() / 1000);
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 30; // Safety limit
    let firstPageItems = [];

    console.log(`Starting pagination from: ${new Date(lastTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    if (lastFetchTimeStr) {
      console.log(`Targeting news since last fetch time: ${lastFetchTimeStr} (Timestamp: ${startTimestamp})`);
    } else {
      console.log(`Targeting news since (default 8:00 AM): ${today8AM.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (Timestamp: ${startTimestamp})`);
    }

    while (hasMore && pageCount < maxPages) {
      const params = {
        app: 'CailianpressWeb',
        last_time: lastTime,
        os: 'web',
        refresh_type: 1, // Crucial: tell server to respect last_time for older items
        rn: 50,
        sv: '7.7.5'
      };
      params.sign = generateSign(params);
      
      const queryString = Object.keys(params).map(k => k + '=' + params[k]).join('&');
      const url = `https://www.cls.cn/v1/roll/get_roll_list?${queryString}`;
      
      const response = await fetchJSON(url);
      
      if (response && response.data && response.data.roll_data && response.data.roll_data.length > 0) {
        const items = response.data.roll_data;
        const pageOldestCtime = items[items.length - 1].ctime;
        
        console.log(`Page ${pageCount + 1}: Fetched ${items.length} items. Oldest in batch: ${new Date(pageOldestCtime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        
        if (pageCount === 0) {
          firstPageItems = items;
        }
        
        let reachedCutoff = false;
        
        for (const item of items) {
          if (item.ctime < startTimestamp) {
            reachedCutoff = true;
            continue; // Stop adding items older than 8:00 AM
          }
          
          // Filter for:
          // 1. Hot/Important news (Level A/B)
          // 2. Structured news with brackets (Level C + 【...】)
          const isHot = item.level === 'A' || item.level === 'B';
          const isStructured = item.level === 'C' && item.content && item.content.includes('【') && item.content.includes('】');
          
          if (isHot || isStructured) {
            const key = `${item.ctime}_${item.content.substring(0, 20)}`;
            if (!seenCtimes.has(key)) {
              uniqueNews.push(item);
              seenCtimes.add(key);
            }
          }
        }
        
        if (reachedCutoff) {
          console.log(`Reached 8:00 AM cutoff.`);
          hasMore = false;
          break;
        }
        
        const oldestItem = items[items.length - 1];
        if (oldestItem && oldestItem.ctime) {
          if (oldestItem.ctime >= lastTime) {
            lastTime = oldestItem.ctime - 1; // Decrement 1s to guarantee progress
          } else {
            lastTime = oldestItem.ctime;
          }
        } else {
          hasMore = false;
        }
        
        pageCount++;
      } else {
        console.log(`No more roll data returned by API.`);
        hasMore = false;
      }
    }

    // Fallback: If no news since the target timestamp AND we don't have a previous fetch timestamp,
    // include the top 10 items anyway.
    if (uniqueNews.length === 0 && firstPageItems.length > 0 && !lastFetchTimeStr) {
      for (const item of firstPageItems.slice(0, 10)) {
        uniqueNews.push(item);
      }
    }
    
    if (uniqueNews.length === 0) {
      console.log(`No new news items since ${lastFetchTimeStr || '08:00 AM'}. File is up to date.`);
      return;
    }
    
    let terminalOutput = `SUCCESS: Fetched ${uniqueNews.length} HOT/Structured news items\n\n`;
    const completionTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    let fileContent = `> Skill executed at: ${completionTime} (Hot & Structured A-Share News)\n\n`;

    if (validIndices.length > 0) {
      const indexString = "📊 **大盘指数**:\n" + validIndices.map(i => `- ${i}`).join('\n') + "\n\n";
      terminalOutput += indexString;
      fileContent += indexString;
    }

    if (uniqueNews.length === 0) {
      terminalOutput += "No matching news found since 08:00 AM today.\n";
    } else {
      uniqueNews.forEach((item, index) => {
        const date = new Date(item.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        // Remove HTML tags if any
        const cleanContent = item.content.replace(/<[^>]*>?/gm, '');
        const itemString = `### ${index + 1}. [${date}]\n${cleanContent}\n\n`;
        terminalOutput += itemString;
        fileContent += itemString;
      });
    }

    fileContent += `---\n\n`;

    let existingContent = "";
    if (fs.existsSync(targetFile)) {
      existingContent = fs.readFileSync(targetFile, 'utf8');
    }
    
    // Prepend to the file
    fs.writeFileSync(targetFile, fileContent + existingContent, 'utf8');
    
    console.log(terminalOutput);
    
  } catch (error) {
    console.error("Error fetching data:", error.message);
    process.exit(1);
  }
}

main();
