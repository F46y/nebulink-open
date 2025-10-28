import {LoggerWithoutDebug, Wllama} from "/static/wllama/esm/index.js";

class MastodonAccount {
    constructor({
                    id, name, accountName, image, token, instance, isActive = 0, topics = [],
                }) {
        this.id = id;
        this.name = name;
        this.accountName = accountName;
        this.image = image;
        this.token = token;
        this.instance = instance.replace(/\/+$/, "");
        this.isActive = isActive ? 1 : 0; // Store as 1/0 for IndexedDB compatibility
        this.topics = Array.isArray(topics) ? topics.slice(0, 20) : [];
        this.updatedAt = new Date().toISOString();
    }

    // Serialize account data for storage
    serialize() {
        return {
            id: this.id,
            name: this.name,
            accountName: this.accountName,
            image: this.image,
            token: this.token,
            instance: this.instance,
            isActive: this.isActive,
            topics: this.topics || [],
            updatedAt: this.updatedAt,
        };
    }

    // Deserialize account data from storage
    static deserialize(data) {
        return new MastodonAccount({
            id: data.id,
            name: data.name,
            accountName: data.accountName,
            image: data.image,
            token: data.token,
            instance: data.instance,
            isActive: data.isActive || 0,
            topics: data.topics || [],
        });
    }
}

class AIHelper {
    kinds = ["web", "wllama", "local"];

    constructor(kind = "auto", features, size, detectLanguageFn) {
        this.kind = kind; // 'auto' | 'web' | 'wllama' | 'local'
        this.size = size || "default";
        this.features = features || {};
        this.llmReady = false;
        this.llmSession = null;
        this.secondarySession = null;
        this.secondaryReady = false;
        this.detector = null;
        this.summarizer = null;
        this.translate = null;
        this.translatorAvailable = null;
        this.language = navigator.language || "en-US";
        this.queue = [];
        this.isProcessing = false;
        this.detectLanguageFn = detectLanguageFn; // function to run for detection
    }

    async init(progressCallback) {
        if (this.kind === "auto") {
            if (this.features.language && this.features.detector) this.kind = "web"; else if (this.features.wasm) this.kind = "wllama"; else this.kind = "failed";
        }
        if (this.features.detector) {
            this.detector = await LanguageDetector.create({
                expectedOutputs: [{type: "text", languages: ["en"]}], async monitor(m) {
                    if ((await LanguageDetector.availability()) !== 'available') {
                        m.addEventListener("downloadprogress", (e) => {
                            let progress = e * 100
                            if (progressCallback) {
                                progressCallback(progress);
                            }
                        })
                    }
                }
            });
        }

        if (this.features.summarize) {
            const options = {
                sharedContext: "These are social media posts. The goal is to summarize the content in a concise and informative way.",
                type: "teaser",
                format: "plain-text",
                expectedInputLanguages: ["en-US"],
                outputLanguage: "en-US",
                length: "medium",
                async monitor(m) {
                    if ((await Summarizer.availabilty()) !== "available") {
                        m.addEventListener('downloadprogress', (e) => {
                            let progress = e * 100
                            if (progressCallback) {
                                progressCallback(progress);
                            }
                        });
                    }
                }
            };

            this.summarizer = await Summarizer.create(options);
        }
        if (this.features.translate) {
            this.translatorAvailable = async (source, target) => {
                return await Translator.availability({
                    sourceLanguage: source, targetLanguage: target,
                });
            };
            this.translate = async (source, target, text, monitor) => {
                const translator = await Translator.create({
                    sourceLanguage: source,
                    targetLanguage: target,
                    async monitor(m) {
                        if ((await Translator.availabilty()) !== "available") {
                            m.addEventListener('downloadprogress', (e) => {
                                let progress = e * 100
                                if (progressCallback) {
                                    progressCallback(progress);
                                }
                            });
                        }
                    }
                });
                return await translator.translate(text);
            };
        }

        if (this.kind === "wllama") {
            const models = [{
                name: "Gemma 3 (270M)",
                size: "small",
                url: "https://huggingface.co/unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q8_0.gguf",
                license: "https://deepmind.google/models/gemma/gemma-3",
                description: "Gemma is a lightweight, family of models from Google built on Gemini technology.",
            }, {
                name: "Gemma 3 (1B - Q4)",
                size: "default",
                url: "https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_0.gguf",
                license: "https://deepmind.google/models/gemma/gemma-3",
                description: "Gemma is a lightweight, family of models from Google built on Gemini technology.",
            }, {
                name: "Gemma 3 (1B - Q8)",
                size: "large",
                url: "https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q8_0.gguf",
                license: "https://deepmind.google/models/gemma/gemma-3",
                description: "Gemma is a lightweight, family of models from Google built on Gemini technology.",
            },];

            this.llmSession = new Wllama({
                "single-thread/wllama.wasm": "/static/wllama/esm/single-thread/wllama.wasm",
                "multi-thread/wllama.wasm": "/static/wllama/esm/multi-thread/wllama.wasm",
            }, {suppressNativeLog: true, logger: LoggerWithoutDebug});

            const m = models.filter((m) => m.size === this.size)[0];
            await this.loadModel("url", m.url, progressCallback);
        } else if (this.kind === "web") {
            this.llmSession = await LanguageModel.create({
                expectedInputs: [{type: "text", languages: ["en"]}],
                expectedOutputs: [{type: "text", languages: ["en"]}],
                initialPrompts: [{
                    role: "system",
                    content: "You are an expert at topic detection and sentiment analysis. Provide accurate, structured responses.",
                },],
            });
        }

        if (this.kind === "failed") {
            throw new Error("No AI capabilities available on this device.");
        }

        return {kind: this.kind};
    }

    async loadModel(kind, source, progressCallback) {
        let ctx = 4096;
        let threads = {
            "single-thread/wllama.wasm": "/static/wllama/esm/single-thread/wllama.wasm",
            "multi-thread/wllama.wasm": "/static/wllama/esm/multi-thread/wllama.wasm",
        };
        try {
            this.llmSession = new Wllama(threads, {
                suppressNativeLog: true, logger: LoggerWithoutDebug,
            });
            const options = {
                useCache: true, allowOffline: true, n_ctx: ctx, progressCallback: (progress) => {
                    if (progressCallback) {
                        progressCallback(progress);
                    }
                    if (progress.total !== progress.loaded) {
                        console.log("Loading: ", progress);
                    }
                },
            };
            if (kind === "url") {
                await this.llmSession.loadModelFromUrl(source, options);
            } else if (kind === "blobs") {
                await this.llmSession.loadModel(source, options);
            }
            this.llmReady = true;
        } catch (err) {
            console.error("Error loading model:", err);
        }
    }

    async initSecondarySession() {
        this.secondarySession = new Wllama({
            "single-thread/wllama.wasm": "/static/wllama/esm/single-thread/wllama.wasm",
            "multi-thread/wllama.wasm": "/static/wllama/esm/multi-thread/wllama.wasm",
        }, {suppressNativeLog: true, logger: LoggerWithoutDebug});

        const models = [{
            name: "LFM2-ENJP (350M)",
            type: "tr-Japanese",
            url: "https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF/resolve/main/LFM2-350M-ENJP-MT-Q4_0.gguf",
            license: "https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF/blob/main/LICENSE",
            description: "Based on the LFM2-350M model, this checkpoint has been fine-tuned for near real-time bi-directional Japanese/English translation of short-to-medium inputs.",
        }, {
            name: "youtube_summarizer",
            type: "summarizer",
            url: "https://huggingface.co/mradermacher/youtube_comments_summarizer-GGUF/resolve/main/youtube_comments_summarizer.Q8_0.gguf",
            license: "https://huggingface.co/Sivakkanth/youtube_comments_summarizer",
            description: "This model is fine-tuned to summarize YouTube comments into a concise summary.",
        },];

        await this.loadSecondaryModel("url", models[0].url);
    }

    async loadSecondaryModel(kind, source) {
        try {
            const options = {
                useCache: false, allowOffline: true, n_ctx: 2048, progressCallback: (progress) => {
                    if (progress.total !== progress.loaded) {
                        console.log("Loading secondary model: ", progress);
                    }
                },
            };
            if (kind === "url") {
                await this.secondarySession.loadModelFromUrl(source, options);
            } else if (kind === "blobs") {
                await this.secondarySession.loadModel(source, options);
            }
            this.secondaryReady = true;
        } catch (err) {
            console.error("Error loading secondary model:", err);
        }
    }

    async handleRequest(pendingRequests, secondary = false) {
        while (pendingRequests.length) {
            const {prompt, options, id} = pendingRequests.shift();
            try {
                if (secondary) {
                    return await this.secondarySession.createCompletion(prompt, options);
                }
                return await this.llmSession.createCompletion(prompt, options);
            } catch (err) {
                return false;
            }
        }
    }

    showDebug(text) {
        const dialog = document.getElementById("debug-dialog");
        if (!dialog) return;
        dialog.querySelector("#debug-message").textContent = text || "";
        dialog.showModal();
    }

    extractJsonFromString(str) {
        const jsonRegex = /{[^{}]*}/;
        const match = str.match(jsonRegex);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    async languageDetect(text) {
        let results = {detectedLanguage: "und", confidence: 1.0};
        if (this.features.detector) {
            const temp = await this.detector.detect(text);
            results = temp[0];
        }

        // else if (this.features.wasm && this.features.memory >= 6) {
        // 	if (!this.secondaryReady) {
        // 		this.secondarySession = await this.initSecondarySession();
        // 		this.secondaryReady = true;
        // 	}

        // 	const response = await this.handleRequest([
        // 		{
        // 			prompt: this.languageDetectionPrompt(text),
        // 			options: {
        // 				sampling: {
        // 					temp: 0.1,
        // 					// top_p: 0.95,
        // 					// top_k: 64,
        // 					// min_p: 0.0,
        // 					// penalty_repeat: 1.0,
        // 				},
        // 				useCache: false,
        // 				stopTokens: await this.secondarySession.tokenize("}"),
        // 			},
        // 			id: Date.now(),
        // 		},
        // 	]);

        // 	const jsonResponse = response.trim() + "}";
        // 	const temp = this.extractJsonFromString(jsonResponse);
        // 	if (temp && temp.detectedLanguage) {
        // 		results = temp.detectedLanguage;
        // 	} else {
        // 		results = { detectedLanguage: "und", confidence: 1.0 };
        // 	}
        // }

        return results;
    }

    //THIS IS PRETTY TRASH...
    languageDetectionPrompt(text) {
        return `
		        <start_of_turn>user\n
		You are a language detection expert. 
		
		Instructions:\n
		- Analyze the given text and tell me what language it's in. \n
		- Reply with a JSON object exactly in this shape:\n
			{"detectedLanguage": string,  "confidence": 0.0-1.0}\n
		 - Never add any other text or explanations.\n
		 - Provide only the JSON object.\n


		 Guidelines:\n
		 - detectedLanguage: The name of the language the text is written in (e.g. English, Japanese, Spanish)\n
		 - confidence: A number between 0.0 and 1.0 indicating how confident you are in your detection.\n

			Now analyze:\n
			 ${text}\n

		<end_of_turn>\n
		<start_of_turn>model\n`;
    }

    //======================SUMMARIZE LOGIC===========================================
    summarizePrompt(text) {
        return `
        <start_of_turn>user\n
You are a helpful assistant that summarizes conversations concisely and clearly.\n

Instructions:\n
- Provide complete summaries without truncation\n
- Don't mention the usernames specifically\n
- Keep responses concise but comprehensive\n
- Avoid unnecessary explanations or meta-commentary\n
- Present only the factual summary\n

Now, analyze and summarize the following conversation:\n

Conversation:\n
${text}\n
Provide the summary now.\n
<end_of_turn>\n
<start_of_turn>model\n
`;
    }

    async summarize(text) {
        let result = "No summary available"
        if (this.features.summarize) {
            result = await this.summarizer.summarize(text);
        } else if (this.features.wasm) {
            result = await this.handleRequest([{
                prompt: this.summarizePrompt(text), options: {
                    // nPredict: 1024,
                    sampling: {
                        temp: 0.1, // top_p: 0.9,
                        // top_k: 64,
                        penalty_repeat: 1.0, // 	penalty_freq: 0.25,
                        // 	penalty_present: 0.25,
                        // 	penalty_last_n: 256,
                    }, useCache: true,
                }, id: Date.now(),
            },]);
        }
        return result;
    }

    //======================SENTIMENT LOGIC===========================================
    sentimentSchema = {
        type: "object", properties: {
            sentiment: {
                type: "string", enum: ["positive", "negative", "neutral"],
            }, confidence: {type: "number", minimum: 0, maximum: 1},
        },
    };

    sentimentPrompt(text, topic) {
        return `
		<start_of_turn>user\n
        You are a sentiment analysis model.\n
		
		Instructions:\n
        - Analyze the sentiment of the given comment regarding the given topic\n
		- Classify as positive, negative, or neutral\n
		- Provide a confidence score between 0.0 and 1.0\n
		- Respond with ONLY valid JSON in this exact format:\n
		{"sentiment": "positive|negative|neutral|unknown", "confidence": 0.0-1.0, "explanation":"summary of why you classify this comment a certain way."}\n

		Guidelines:
		- Positive: expresses satisfaction, joy, approval, or optimism\n
		- Negative: expresses dissatisfaction, anger, criticism, or pessimism\n  
		- Neutral: factual, objective, or mixed sentiment\n
		- Unknown: if sentiment is unclear or cannot be determined\n
		- Confidence: how certain you are of the classification\n
		- Explanation: brief summary of reasoning behind classification\n

		Examples:\n
		{"sentiment": "positive", "confidence": 0.95, "explanation": "Commentor said they liked the topic"}\n
		{"sentiment": "negative", "confidence": 0.87, "explanation": "Commentor said they hate the topic"}\n
		{"sentiment": "negative", "confidence": 0.60, "explanation": "Commentor expressed some criticism about the topic"}\n
		{"sentiment": "negative", "confidence": 0.90, "explanation": "Commentor expressed anger about the topic"}\n
		{"sentiment": "positive", "confidence": 0.70, "explanation": "Commentor expressed some approval about the topic"}\n
		{"sentiment": "neutral", "confidence": 0.85, "explanation": "Commentor provided factual information about the topic"}\n
		{"sentiment": "neutral", "confidence": 0.50, "explanation": "Commentor had mixed feelings about the topic"}\n
		{"sentiment": "unknown", "confidence": 0.99, "explanation": "Commentor didn't express any opinions regarding the topic"}\n
		{"sentiment": "unknown", "confidence": 0.75, "explanation": "Commentor's opinion was ambiguous regarding the topic"}\n
		{"sentiment": "unknown", "confidence": 0.65, "explanation": "Commentor didn't mention the topic"}\n
		{"sentiment": "unknown", "confidence": 0.80, "explanation": "Commentor's opinion regarding the topic couldn't be ascertained"}\n

		Are you ready?

		<end_of_turn>\n
		<start_of_turn>model\n

		Yes, I am ready. Please provide the comment and topic for analysis.
		<end_of_turn>\n

		<start_of_turn>user\n
		Comment:\n
		 ${text}\n

		Topic: ${topic}\n

		 \nNow analyze the sentiment of this and respond.\n
		<end_of_turn>\n
		<start_of_turn>model\n`;
    }

    async analyze(text, topic) {
        let result;
        if (this.kind === "web") {
            result = await this.llmSession.prompt(`Analyze the sentiment of this comment:\n\n"${text}"`, {responseConstraint: this.sentimentSchema});

            result = JSON.parse(result);
        } else if (this.kind === "wllama") {
            result = await this.handleRequest([{
                prompt: this.sentimentPrompt(text, topic), options: {
                    n_predict: 1024, sampling: {
                        temp: 0.1, penalty_repeat: 1.0,
                    }, useCache: true, stopTokens: await this.llmSession.tokenize("}"),
                }, id: Date.now(),
            },]);

            result = result.trim() + "}";
            result = this.extractJsonFromString(result);
        }
        if (!result || !result.sentiment) {
            return {
                sentiment: "unknown", confidence: 0.0, explanation: "Could not analyze sentiment.",
            };
        }
        return result;
    }

    //======================RELEVANCE LOGIC===========================================

    topicSchema = {
        type: "object", properties: {
            topics: {
                type: "array", items: {type: "string"}, minItems: 1, maxItems: 5,
            },
        }, required: ["topics"], additionalProperties: false,
    };

    relevanceSchema = {
        type: "object", properties: {
            isRelevant: {type: "boolean"}, confidence: {type: "number", minimum: 0, maximum: 1},
        },
    };

    relevancePrompt(comment) {
        return `
		<start_of_turn>user
		You are a JSON-only relevance classifier.
		
		Analyze the comment below and identify the main subjects discussed.
        
        Requirements:
        - Return ONLY valid JSON in this exact format: {"subjects": ["subject1", "subject2"]}
        - Each subject must be 3 words or less
        - Include up to 5 subjects maximum
        - List subjects in order of prominence/appearance
        - Only include subjects explicitly mentioned or clearly alluded to
        - Be specific, not vague
        - NO explanatory text before or after the JSON
        
        Comment:
        "${comment}"
        
        <end_of_turn>
		<start_of_turn>model
        `;
    }

    async classifyTopics(comment) {
        let result;
        if (this.kind === "web") {
            result = await this.llmSession.prompt(`You are a helpful relevance classifier.\n	
				Classify the comment below into the main subjects discussed.\n
				Comment:\n 
				"${comment}"`, {responseConstraint: this.topicSchema});

            console.log(result);
            result = JSON.parse(result);
        } else {
            this.llmSession.kvClear();

            let tempRes = await this.handleRequest([{
                prompt: this.relevancePrompt(comment), options: {
                    n_predict: 1024, sampling: {
                        temp: 1.0, top_p: 0.95, top_k: 64, min_p: 0.1,
                    },
                },
            },]);
            tempRes = tempRes.trim() + "}";
            tempRes = this.extractJsonFromString(tempRes);
            if (tempRes && tempRes.subjects) {
                result = {
                    topics: tempRes.subjects,
                };
            } else {
                result = {
                    topics: [],
                };
            }
        }

        return result;
    }

    async isRelevantToTopic(comment, topic) {
        let result = {
            isRelevant: false,
        };
        if (this.kind === "web") {
            result = await this.llmSession.prompt(`You are a helpful relevance classifier.\n	
				Does this comment discuss "${topic}"?\n
				Comment:\n 
				"${comment}"`, {responseConstraint: this.relevanceSchema});
            result = JSON.parse(result);
        } else {
            this.llmSession.kvClear();

            let tempRes = await this.handleRequest([{
                prompt: this.relevancePrompt(comment), options: {
                    n_predict: 1024, sampling: {
                        temp: 1.0, top_p: 0.95, top_k: 64, min_p: 0.1, penalty_freq: 0.25, penalty_repeat: 1.0,
                    }, useCache: true, stopTokens: await this.llmSession.tokenize("}"),
                }, id: Date.now(),
            },]);

            tempRes = tempRes.trim() + "}";
            tempRes = this.extractJsonFromString(tempRes);

            if (tempRes && tempRes.subjects) {
                tempRes.subjects.find((item) => {
                    if (item.toLowerCase().includes(topic.toLowerCase())) {
                        result.isRelevant = true;
                    }
                });
            }
        }
        if (!result) {
            return;
        }
        return result;
    }

    //======================LANGUAGE DETECTION QUEUE===========================================
    addToLangDetQueue(item) {
        this.queue.push(item);
        this.processLangDetQueue();
    }

    async processLangDetQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await this.detectLanguageFn(item);
            } catch (e) {
                console.error("Language detection failed:", e);
            }
        }
        this.isProcessing = false;
    }
}

export {MastodonAccount, AIHelper};
