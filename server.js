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
    fs.mkdirSync(uploadDir, { recursive: true });
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

// Configure multer with error handling
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

app.use(cors({
    origin: ['https://paper-simplifier.onrender.com', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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

        // Extract citations, key findings, and fact check in parallel
        const [citations, findings, factCheck] = await Promise.all([
            extractCitations(text),
            extractKeyFindings(text),
            checkFactualAccuracy(text)
        ]);

        const processingTime = Date.now() - startTime;
        const cost = (totalTokens.input + totalTokens.output) * 0.002 / 1000;

        return {
            summaries,
            citations,
            findings,
            factCheck, // Add fact check to the response
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
    try {
        console.log('Processing request...');
        
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
                    citations, key_findings, fact_check, input_tokens, output_tokens, 
                    cost, processing_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                req.file.originalname,
                data.text,
                result.summaries.child,
                result.summaries.college,
                result.summaries.phd,
                result.citations,
                result.findings,
                result.factCheck,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('OpenAI API Key status:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');
});