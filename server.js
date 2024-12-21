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

// Initialize database
let db;
(async () => {
    db = await open({
        filename: 'papers.db',
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

// Define the upload directory and configure multer
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : './uploads';

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    },
});

const upload = multer({ storage: storage });

// Set up CORS with specific origins
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
        const response = await openAI.chat.completions.create({
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
        const response = await openAI.chat.completions.create({
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

        // Extract citations and key findings
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
            text: text,  // Include the full text in the response
            rawText: text,  // Additional field for raw text
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

// Chat endpoint with improved content handling
app.post('/api/chat', async (req, res) => {
    try {
        console.log('Received chat request');
        const { message, paperContent } = req.body;
        
        console.log('Message received:', message);
        console.log('Paper content length:', paperContent?.length || 0);

        if (!paperContent || paperContent.length === 0) {
            // Try to get the paper content from the database using the last processed paper
            const lastPaper = await db.get('SELECT text FROM papers ORDER BY timestamp DESC LIMIT 1');
            if (lastPaper && lastPaper.text) {
                console.log('Retrieved paper content from database');
                const response = await openAI.chat.completions.create({
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

        console.log('Received response from OpenAI');
        res.json({ response: response.choices[0].message.content });
    } catch (error) {
        console.error('Error in chat endpoint:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to process paper
app.post('/api/process', upload.single('file'), async (req, res) => {
    try {
        console.log('Starting file process...');
        if (!req.file) {
            console.log('No file found in request');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('File received:', req.file.originalname);
        const dataBuffer = require('fs').readFileSync(req.file.path);
        console.log('File read successfully, size:', dataBuffer.length);
        
        const data = await pdfParse(dataBuffer);
        console.log('PDF parsed successfully, text length:', data.text.length);

        if (isProcessing) {
            queue.push({ text: data.text, res });
            return;
        }

        isProcessing = true;
        const result = await generateSummaries(data.text);
        
        // Save to database
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
            const next = queue.shift();
            generateSummaries(next.text)
                .then(sum => next.res.json(sum))
                .catch(err => next.res.status(500).json({ error: err.message }));
        }

        res.json({
            ...result,
            rawText: data.text  // Include raw text in response
        });

    } catch (error) {
        console.error('Error processing request:', error);
        isProcessing = false;
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('OpenAI API Key status:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');
});
