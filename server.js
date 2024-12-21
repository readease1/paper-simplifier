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

// Define upload directory and log it
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : './uploads';
console.log('Upload directory:', uploadDir);

// Initialize database
let db;
(async () => {
    db = await open({
        filename: process.env.NODE_ENV === 'production' ? '/tmp/papers.db' : 'papers.db',
        driver: sqlite3.Database
    });

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
            input_tokens INTEGER,
            output_tokens INTEGER,
            cost REAL,
            processing_time INTEGER
        );
    `);
})();

const app = express();

// Initialize OpenAI with proper naming
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Configure multer with detailed logging
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        console.log('Creating upload directory:', uploadDir);
        try {
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
                console.log('Created upload directory');
            }
            cb(null, uploadDir);
        } catch (err) {
            console.error('Error creating upload directory:', err);
            cb(err);
        }
    },
    filename: function (req, file, cb) {
        const filename = Date.now() + '-' + file.originalname;
        console.log('Generated filename:', filename);
        cb(null, filename);
    }
});

const upload = multer({ storage: storage });

// Fixed CORS settings
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

// Extract citations from text
async function extractCitations(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ 
                role: "user", 
                content: `Extract and list all citations and references from this text. Format them consistently:
                         ${text.substring(0, 2000)}...`
            }],
            max_tokens: 200
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error extracting citations:', error);
        return 'Error extracting citations';
    }
}

// Extract key findings
async function extractKeyFindings(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ 
                role: "user", 
                content: `List the 5 most important findings or conclusions from this paper:
                         ${text.substring(0, 2000)}...`
            }],
            max_tokens: 200
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error extracting key findings:', error);
        return 'Error extracting key findings';
    }
}
// Helper function to generate summaries
async function generateSummaries(text) {
    const startTime = Date.now();
    const levels = ['child', 'college', 'phd'];
    const summaries = {};
    let totalTokens = { input: 0, output: 0 };

    try {
        for (const level of levels) {
            console.log(`Generating ${level} level summary...`);
            const response = await openai.chat.completions.create({
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

        console.log('Extracting citations and findings...');
        const [citations, findings] = await Promise.all([
            extractCitations(text),
            extractKeyFindings(text)
        ]);

        const processingTime = Date.now() - startTime;
        const cost = (totalTokens.input + totalTokens.output) * 0.002 / 1000;

        return {
            summaries,
            citations,
            findings,
            text: text,
            rawText: text,
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

// Chat endpoint with improved logging
app.post('/api/chat', async (req, res) => {
    try {
        console.log('Received chat request');
        const { message, paperContent } = req.body;
        
        console.log('Message received:', message);
        console.log('Paper content length:', paperContent?.length || 0);

        if (!paperContent || paperContent.length === 0) {
            console.log('Attempting to retrieve paper from database...');
            const lastPaper = await db.get('SELECT text FROM papers ORDER BY timestamp DESC LIMIT 1');
            if (lastPaper && lastPaper.text) {
                console.log('Retrieved paper content from database');
                const response = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        { 
                            role: "system", 
                            content: "You are a helpful academic assistant. Answer questions about the paper clearly and concisely based on the content provided." 
                        },
                        { 
                            role: "user", 
                            content: `Here is the paper content: ${lastPaper.text.substring(0, 2000)}...

Question about this paper: ${message}`
                        }
                    ],
                    max_tokens: 500
                });
                return res.json({ response: response.choices[0].message.content });
            }
            console.log('No paper content provided');
            return res.json({ 
                response: "Please provide the paper content or try uploading the paper again." 
            });
        }

        console.log('Sending request to OpenAI');
        const response = await openai.chat.completions.create({
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

        console.log('Received response from OpenAI');
        res.json({ response: response.choices[0].message.content });
    } catch (error) {
        console.error('Error in chat endpoint:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to process paper with enhanced error logging
app.post('/api/process', upload.single('file'), async (req, res) => {
    try {
        console.log('Starting file process...');
        if (!req.file) {
            console.log('No file found in request');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('File received:', req.file);  // Log full file object
        console.log('File path:', req.file.path);
        console.log('Attempting to read file...');

        try {
            // Check if file exists
            if (!fs.existsSync(req.file.path)) {
                throw new Error('File does not exist at path: ' + req.file.path);
            }

            const dataBuffer = fs.readFileSync(req.file.path);
            console.log('File read successfully, size:', dataBuffer.length);
            
            // Check if buffer is empty
            if (!dataBuffer.length) {
                throw new Error('File buffer is empty');
            }
            
            console.log('Attempting to parse PDF...');
            const data = await pdfParse(dataBuffer);
            console.log('PDF parsed successfully, text length:', data.text.length);

            // Check if text was extracted
            if (!data.text || data.text.length === 0) {
                throw new Error('No text extracted from PDF');
            }

            if (isProcessing) {
                console.log('System busy, adding to queue...');
                queue.push({ text: data.text, res });
                return;
            }

            console.log('Starting summary generation...');
            isProcessing = true;
            const result = await generateSummaries(data.text);
            
            console.log('Saving to database...');
            await db.run(`
                INSERT INTO papers (
                    title, text, child_summary, college_summary, phd_summary, 
                    citations, key_findings, input_tokens, output_tokens, 
                    cost, processing_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                req.file.originalname,
                data.text,
                result.summaries.child,
                result.summaries.college,
                result.summaries.phd,
                result.citations,
                result.findings,
                result.stats.inputTokens,
                result.stats.outputTokens,
                result.stats.cost,
                result.stats.processingTime
            ]);

            isProcessing = false;

            if (queue.length > 0) {
                console.log('Processing next item in queue...');
                const next = queue.shift();
                generateSummaries(next.text)
                    .then(sum => next.res.json(sum))
                    .catch(err => next.res.status(500).json({ error: err.message }));
            }

            console.log('Sending response...');
            res.json({
                ...result,
                rawText: data.text
            });

        } catch (fileError) {
            console.error('Detailed file error:', fileError);
            console.error('Error stack:', fileError.stack);
            throw new Error(`File processing failed: ${fileError.message}`);
        }

    } catch (error) {
        console.error('Full error details:', error);
        console.error('Error stack:', error.stack);
        isProcessing = false;
        res.status(500).json({ 
            error: error.message,
            details: error.stack,
            path: req.file?.path,
            originalName: req.file?.originalname
        });
    } finally {
        // Clean up uploaded file
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
                console.log('Cleaned up uploaded file');
            } catch (cleanupError) {
                console.error('Error cleaning up file:', cleanupError);
            }
        }
    }
});

// Get recent papers
app.get('/api/recent', async (req, res) => {
    try {
        const papers = await db.all(`
            SELECT id, title, timestamp, child_summary, college_summary, phd_summary,
                   citations, key_findings, input_tokens, output_tokens, cost, 
                   processing_time, text
            FROM papers 
            ORDER BY timestamp DESC 
            LIMIT 10
        `);
        res.json(papers);
    } catch (error) {
        console.error('Error fetching recent papers:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get stats
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.get(`
            SELECT 
                COUNT(*) as total_papers,
                AVG(processing_time) as avg_processing_time,
                SUM(cost) as total_cost,
                AVG(input_tokens + output_tokens) as avg_tokens
            FROM papers
        `);
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
    console.log('Environment:', process.env.NODE_ENV || 'development');
});