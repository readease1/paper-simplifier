const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Create upload directory if it doesn't exist
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : './uploads';
if (!fs.existsSync(uploadDir)) {
    try {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log('Upload directory created:', uploadDir);
    } catch (error) {
        console.error('Error creating upload directory:', error);
    }
}

console.log('Environment:', process.env.NODE_ENV);
console.log('Upload directory:', uploadDir);

// Initialize database
let db;
(async () => {
    try {
        const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/papers.db' : 'papers.db';
        console.log('Database path:', dbPath);
        
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        console.log('Database connection established');

        // Create tables if they don't exist
        await db.exec(`
            CREATE TABLE IF NOT EXISTS papers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                text TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                child_summary TEXT,
                college_summary TEXT,
                phd_summary TEXT,
                citations TEXT,
                key_findings TEXT,
                fact_check TEXT,
                category TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cost REAL,
                processing_time INTEGER
            );
        `);
        console.log('Database table created/verified');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
})();

const app = express();

// Initialize OpenAI
const openAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
    console.error('WARNING: OPENAI_API_KEY is not set');
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

// Configure multer BEFORE cors
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Request logging middleware
app.use((req, res, next) => {
    console.log('Incoming request:', {
        path: req.path,
        method: req.method,
        contentType: req.headers['content-type']
    });
    next();
});

// CORS configuration
app.use(cors({
    origin: true, // Accept all origins in development
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// Additional CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).json({ status: 'ok' });
    }
    
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Handle HEAD requests for the root path
app.head('/', (req, res) => {
    res.status(200).end();
});

// Process queue
let isProcessing = false;
const queue = [];

// Extract citations from text with enhanced error handling
async function extractCitations(text) {
    try {
        console.log('Extracting citations...');
        const response = await openAI.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ 
                role: "user", 
                content: `Extract and list all citations and references from this text. Format them consistently:
                         ${text.substring(0, 2000)}...`
            }],
            max_tokens: 200
        });
        console.log('Citations extracted successfully');
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error extracting citations:', error);
        return 'Error extracting citations: ' + error.message;
    }
}

// Extract key findings with enhanced error handling
async function extractKeyFindings(text) {
    try {
        console.log('Extracting key findings...');
        const response = await openAI.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ 
                role: "user", 
                content: `List the 5 most important findings or conclusions from this paper:
                         ${text.substring(0, 2000)}...`
            }],
            max_tokens: 200
        });
        console.log('Key findings extracted successfully');
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error extracting key findings:', error);
        return 'Error extracting key findings: ' + error.message;
    }
}

async function checkFactualAccuracy(text) {
    try {
        console.log('Checking factual accuracy...');
        const response = await openAI.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "You are a fact-checking assistant specialized in academic papers. Focus on: 1) Verifying numerical claims and statistics, 2) Identifying potential inconsistencies or errors, 3) Flagging unsupported claims or potential misinformation. Be specific and cite the relevant parts of the text."
                },
                {
                    role: "user",
                    content: `Analyze this academic paper for numerical accuracy and potential misinformation. Focus on statistics, data claims, and any suspicious assertions:

${text.substring(0, 2000)}...`
                }
            ],
            max_tokens: 500
        });
        console.log('Fact check completed');
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error checking factual accuracy:', error);
        return 'Error performing fact check: ' + error.message;
    }
}

async function determineCategory(text) {
    try {
        console.log('Determining paper category...');
        const response = await openAI.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "You are a research paper categorization assistant. Categorize papers into exactly ONE of these categories: Sports, Medicine, Technology, Science, Business, Psychology, Education, Arts, Environment, Politics. Choose the most relevant category based on the content."
                },
                {
                    role: "user",
                    content: `Categorize this academic paper into one of the predefined categories. Analyze the content and provide ONLY the category name, nothing else:

${text.substring(0, 2000)}...`
                }
            ],
            max_tokens: 50
        });
        const category = response.choices[0].message.content.trim();
        console.log('Category determined:', category);
        return category;
    } catch (error) {
        console.error('Error determining category:', error);
        return 'Uncategorized';
    }
}

// Helper function to generate summaries with enhanced error handling
async function generateSummaries(text) {
    const startTime = Date.now();
    const levels = ['child', 'college', 'phd'];
    const summaries = {};
    let totalTokens = { input: 0, output: 0 };

    try {
        // Generate summaries for each level
        for (const level of levels) {
            const response = await openAI.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{ 
                    role: "user", 
                    content: `Summarize this academic paper for a ${level} level reader: ${text.substring(0, 2000)}...`
                }],
                max_tokens: 200
            });
            summaries[level] = response.choices[0].message.content;
            totalTokens.input += response.usage.prompt_tokens;
            totalTokens.output += response.usage.completion_tokens;
        }

        // Extract citations, key findings, fact check, and category in parallel
        const [citations, findings, factCheck, category] = await Promise.all([
            extractCitations(text),
            extractKeyFindings(text),
            checkFactualAccuracy(text),
            determineCategory(text)
        ]);

        const processingTime = Date.now() - startTime;
        const cost = (totalTokens.input + totalTokens.output) * 0.002 / 1000;

        return {
            summaries,
            citations,
            findings,
            factCheck,
            category,
            text: text,
            stats: {
                inputTokens: totalTokens.input,
                outputTokens: totalTokens.output,
                cost: cost.toFixed(4),
                processingTime
            }
        };
    } catch (error) {
        console.error('Error in generateSummaries:', error);
        throw error;
    }
}

// Enhanced chat endpoint with improved error handling
app.post('/api/chat', async (req, res) => {
    try {
        console.log('Received chat request');
        const { message, paperContent } = req.body;

        if (!paperContent) {
            console.log('No paper content provided');
            return res.json({ 
                response: "Please provide the paper content or try uploading the paper again." 
            });
        }

        console.log('Processing chat message:', message.substring(0, 50) + '...');
        const response = await openAI.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { 
                    role: "system", 
                    content: "You are a helpful academic assistant. Answer questions about the paper clearly and concisely based on the content provided." 
                },
                { 
                    role: "user", 
                    content: `Here is the paper content: ${paperContent.substring(0, 2000)}...

Question about this paper: ${message}`
                }
            ],
            max_tokens: 500
        });

        console.log('Chat response generated successfully');
        res.json({ response: response.choices[0].message.content });
    } catch (error) {
        console.error('Error in chat endpoint:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enhanced API endpoint to process paper with improved error handling
app.post('/api/process', upload.single('file'), async (req, res) => {
    console.log('Received upload request:', {
        method: req.method,
        contentType: req.headers['content-type'],
        file: req.file ? 'Present' : 'Missing'
    });

    try {
        if (!req.file) {
            console.error('No file uploaded');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('File details:', {
            filename: req.file.originalname,
            path: req.file.path,
            size: req.file.size
        });

        // Check if file exists
        if (!fs.existsSync(req.file.path)) {
            console.error('File not found after upload:', req.file.path);
            return res.status(500).json({ error: 'File not found after upload' });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        console.log('File read successful, size:', dataBuffer.length);

        const data = await pdfParse(dataBuffer);
        console.log('PDF parsing successful, text length:', data.text.length);

        if (isProcessing) {
            queue.push({ text: data.text, res });
            return;
        }

        isProcessing = true;
        const result = await generateSummaries(data.text);
        
        // Save to database with error handling
        try {
            await db.run(`
                INSERT INTO papers (
                    title, text, child_summary, college_summary, phd_summary, 
                    citations, key_findings, fact_check, category, input_tokens, output_tokens, 
                    cost, processing_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                req.file.originalname,
                data.text,
                result.summaries.child,
                result.summaries.college,
                result.summaries.phd,
                result.citations,
                result.findings,
                result.factCheck,
                result.category,
                result.stats.inputTokens,
                result.stats.outputTokens,
                result.stats.cost,
                result.stats.processingTime
            ]);
            console.log('Database insert successful');
        } catch (dbError) {
            console.error('Database error:', dbError);
        }

        isProcessing = false;

        if (queue.length > 0) {
            const next = queue.shift();
            generateSummaries(next.text)
                .then(sum => next.res.json(sum))
                .catch(err => next.res.status(500).json({ error: err.message }));
        }

        // Cleanup uploaded file
        try {
            fs.unlinkSync(req.file.path);
            console.log('Temporary file cleaned up');
        } catch (cleanupError) {
            console.error('File cleanup error:', cleanupError);
        }

        res.json(result);

    } catch (error) {
        console.error('Error processing request:', error);
        isProcessing = false;
        res.status(500).json({ error: error.message });
    }
});

// Enhanced recent papers endpoint with error logging
app.get('/api/recent', async (req, res) => {
    try {
        console.log('Fetching recent papers...');
        const papers = await db.all(`
            SELECT * FROM papers 
            ORDER BY timestamp DESC 
            LIMIT 10
        `);
        console.log(`Found ${papers.length} recent papers`);
        res.json(papers);
    } catch (error) {
        console.error('Error fetching recent papers:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        console.log('Fetching categories...');
        const categories = await db.all(`
            SELECT DISTINCT category 
            FROM papers 
            WHERE category IS NOT NULL 
            ORDER BY category
        `);
        res.json(categories.map(c => c.category));
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get papers by category
app.get('/api/papers/:category', async (req, res) => {
    try {
        const category = req.params.category;
        console.log('Fetching papers for category:', category);
        const papers = await db.all(`
            SELECT * FROM papers 
            WHERE category = ? 
            ORDER BY timestamp DESC
        `, [category]);
        res.json(papers);
    } catch (error) {
        console.error('Error fetching papers by category:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enhanced stats endpoint with error logging
app.get('/api/stats', async (req, res) => {
    try {
        console.log('Fetching stats...');
        const stats = await db.get(`
            SELECT 
                COUNT(*) as total_papers,
                AVG(processing_time) as avg_processing_time,
                SUM(cost) as total_cost,
                AVG(input_tokens + output_tokens) as avg_tokens
            FROM papers
        `);
        console.log('Stats retrieved successfully');
        res.json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).json({ 
        error: err.message,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('OpenAI API Key status:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');
});