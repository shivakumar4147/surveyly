document.addEventListener('DOMContentLoaded', function() {
    // Supabase client init and helpers (replaces localStorage)
    let supabaseClient = null;
    const questionCache = new Map();
    const idToCode = new Map();
    async function initSupabaseClient() {
        try {
            const res = await fetch('/env.json');
            const cfg = await res.json();
            if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase) {
                supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
            }
        } catch (e) { console.error('Supabase init failed', e); }
    }
    async function getQuestionByCode(code) {
        if (!supabaseClient) return null;
        if (questionCache.has(code)) return questionCache.get(code);
        const { data, error } = await supabaseClient.from('survey_questions').select('*').eq('code', code).maybeSingle();
        if (error) { console.warn('getQuestionByCode error', code, error.message); return null; }
        if (data) {
            questionCache.set(code, data);
            if (data.id && data.code) idToCode.set(data.id, data.code);
        }
        return data;
    }
    async function ensureBaseQuestions() {
        if (!supabaseClient) return;
        const base = [
            { code: 'age', text: 'What is your age group?', type: 'radio', options: ['10-20','20-40','40-60','60+'] },
            { code: 'location', text: 'Where do you usually buy perfumes?', type: 'radio', options: ['Brands','Malls','Online','Supermarkets','Other'] },
            { code: 'frequency', text: 'How often do you use perfumes?', type: 'radio', options: ['Daily','Few times a week','Occasionally','Rarely','Never'] },
            { code: 'reason', text: 'Why do you use perfumes?', type: 'radio', options: ['Personal hygiene','Social occasions','Professional settings','Self-confidence','Other'] },
            { code: 'problems', text: 'What problems have you faced with perfumes outside?', type: 'radio', options: ['Too expensive','Not portable','Runs out quickly','No problems','Other'] },
            { code: 'would_use', text: 'Would you use a ₹5 per spray perfume vending machine?', type: 'radio', options: ['Definitely','Probably','Not sure','Probably not','Definitely not'] },
            { code: 'installation', text: 'Where would you prefer to see these vending machines installed?', type: 'radio', options: ['Malls','Gyms','Public restrooms','Office buildings','Other'] },
            { code: 'test_public', text: 'Would you test using a public perfume vending machine?', type: 'radio', options: ['Yes','No','Maybe'] }
        ];
        for (const q of base) {
            const { data: existing } = await supabaseClient.from('survey_questions').select('*').eq('code', q.code).maybeSingle();
            if (!existing) {
                const { data } = await supabaseClient.from('survey_questions').insert({ code: q.code, text: q.text, type: q.type, options: q.options, in_bank: true }).select('*').single();
                if (data) {
                    questionCache.set(q.code, data);
                    if (data.id && data.code) idToCode.set(data.id, data.code);
                }
            } else {
                questionCache.set(q.code, existing);
                if (existing.id && existing.code) idToCode.set(existing.id, existing.code);
            }
        }
    }
    
    // Hydrate in-memory counts from Supabase
    async function hydrateFromSupabase() {
        if (!supabaseClient) return;
        // Fetch all questions so hydration includes custom ones
        const { data: questions, error: qErr } = await supabaseClient
            .from('survey_questions')
            .select('id, code, text, type, options');
        if (qErr) { console.warn('hydrate questions error', qErr.message); return; }
        for (const q of (questions || [])) {
            if (!q || !q.id || !q.code) continue;
            idToCode.set(q.id, q.code);
            questionCache.set(q.code, q);
            const { data: resp, error } = await supabaseClient
                .from('survey_responses')
                .select('answer')
                .eq('question_id', q.id);
            if (error) { console.warn('hydrate responses error', q.code, error.message); continue; }
            const counts = {};
            (resp || []).forEach(row => {
                const ans = (row.answer || '').trim();
                if (!ans) return;
                counts[ans] = (counts[ans] || 0) + 1;
            });
            surveyData[q.code] = counts;
            // Ensure the custom question is present in UI if not base
            if (q.code.startsWith('custom_')) {
                const opts = Array.isArray(q.options) ? q.options : (q.options ? Object.values(q.options) : []);
                if (!document.getElementById(`question-${q.code}`)) {
                    addQuestionToSurvey(q.code, q.text, opts, q.type || 'radio');
                    addQuestionToResults(q.code, q.text);
                }
                surveyData[q.code + '_text'] = q.text;
                surveyData[q.code + '_type'] = q.type || 'radio';
            }
        }
        // Update form count display
        updateFormCountDisplay();
        // Ensure numbers are sequential after hydration
        renumberQuestions();
    }

    async function setupRealtime() {
        if (!supabaseClient) return;
        const ch = supabaseClient.channel('realtime-updates');
        ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'survey_responses' }, async (payload) => {
            try {
                const newRow = payload.new || {};
                const qid = newRow.question_id;
                const ans = (newRow.answer || '').trim();
                if (!qid || !ans) return;
                let code = idToCode.get(qid);
                if (!code) {
                    const { data } = await supabaseClient.from('survey_questions').select('code').eq('id', qid).maybeSingle();
                    if (data && data.code) {
                        code = data.code;
                        idToCode.set(qid, code);
                    }
                }
                if (!code) return;
                const cur = surveyData[code] || {};
                cur[ans] = (cur[ans] || 0) + 1;
                surveyData[code] = cur;
                const activeBtn = document.querySelector('.result-btn.active');
                const activeQuestion = activeBtn ? activeBtn.getAttribute('data-question') : null;
                if (activeQuestion === code) {
                    showResults(code);
                }
            } catch (e) { console.warn('Realtime response update failed', e.message); }
        });
        ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'form_stats' }, async () => {
            try { await updateFormCountDisplay(); } catch (_) {}
        });
        ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'suggestions' }, async (payload) => {
            const s = payload.new || {};
            if (!s || !s.text) return;
            // Update general suggestions
            surveyData.suggestions = surveyData.suggestions || [];
            surveyData.suggestions.unshift({ id: s.id, text: s.text, flagged: s.status === 'red', flagReason: '', status: s.status || 'none' });
            const isResultsActive = resultsContainer.classList.contains('active');
            if (isResultsActive) await displaySuggestions();
            // If active question is text and matches suggestion question_code, refresh feedback list
            const activeBtn = document.querySelector('.result-btn.active');
            const activeQuestion = activeBtn ? activeBtn.getAttribute('data-question') : null;
            const activeType = activeQuestion ? (surveyData[activeQuestion + '_type'] || (questionCache.get(activeQuestion)?.type) || 'radio') : 'radio';
            if (activeQuestion && activeType === 'text' && s.question_code === activeQuestion) {
                await displayQuestionFeedback(activeQuestion);
            }
        });
        await ch.subscribe();
    }
    
    // Function to add delete buttons to existing questions
    function addDeleteButtonsToExistingQuestions() {
        const questions = document.querySelectorAll('.question');
        questions.forEach(question => {
            // Skip if it already has a delete button
            if (question.querySelector('.delete-question-btn')) return;
            
            // Get the question ID from the first radio input
            const radioInput = question.querySelector('input[type="radio"]');
            if (!radioInput) return;
            
            const questionId = radioInput.name;
            
            // Create question header
            const questionHeader = document.createElement('div');
            questionHeader.className = 'question-header';
            
            // Move the h3 into the header
            const heading = question.querySelector('h3');
            if (heading) {
                question.removeChild(heading);
                questionHeader.appendChild(heading);
            }
            
            // Create delete button
            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-question-btn';
            deleteButton.innerHTML = '&times;';
            deleteButton.title = 'Delete Question';
            deleteButton.setAttribute('data-question-id', questionId);
            deleteButton.addEventListener('click', async function() {
                const password = prompt('Enter admin password to delete this question:');
                if (!password) return;
                try {
                    const q = await getQuestionByCode(questionId);
                    if (!q || !q.id) { alert('Question not found in backend.'); return; }
                    const res = await fetch('/admin/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entity_type: 'survey_questions', id: q.id, admin_password: password })
                    });
                    const out = await res.json();
                    if (out.success) {
                        const elem = document.getElementById(`question-${questionId}`) || question;
                        if (elem) elem.remove();
                        const navBtn = document.querySelector(`.results-nav [data-question="${questionId}"]`);
                        if (navBtn) navBtn.remove();
                        updateCharts();
                    } else {
                        alert('Delete failed: ' + (out.error || 'Unknown error'));
                    }
                } catch (e) {
                    alert('Delete error: ' + e.message);
                }
            });
            
            questionHeader.appendChild(deleteButton);
            
            // Insert header at the beginning of the question
            question.insertBefore(questionHeader, question.firstChild);
        });
    }
    // DOM Elements
    const surveyContainer = document.getElementById('survey-container');
    const resultsContainer = document.getElementById('results-container');
    const surveyForm = document.getElementById('survey-form');
    const submitBtn = document.getElementById('submit-btn');
    const backToSurveyBtn = document.getElementById('back-to-survey');
    const viewGraphBtn = document.getElementById('view-graph-btn');
    const addQuestionBtn = document.getElementById('add-question-btn');
    const addQuestionModal = document.getElementById('add-question-modal');
    const deleteConfirmModal = document.getElementById('delete-confirm-modal');
    const closeModalBtns = document.querySelectorAll('.close-modal');
    const deletePassword = document.getElementById('delete-password');
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
    const addQuestionForm = document.getElementById('add-question-form');
    const resultButtons = document.querySelectorAll('.result-btn');
    const resultsChart = document.getElementById('results-chart');
    const exportPdfBtn = document.getElementById('export-pdf');
    const exportCsvBtn = document.getElementById('export-csv');
    const exportExcelBtn = document.getElementById('export-excel');
    const exportWordBtn = document.getElementById('export-word');
    
    // Admin deletion is now performed via server-side verification; no client-stored password
    
    // Variable to store the question ID to be deleted
    let questionToDelete = null;
    
    // Event listeners for export buttons
    if (exportPdfBtn) {
        exportPdfBtn.addEventListener('click', exportToPDF);
    }
    
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', exportToCSV);
    }
    
    if (exportExcelBtn) {
        exportExcelBtn.addEventListener('click', exportToExcel);
    }
    
    if (exportWordBtn) {
        exportWordBtn.addEventListener('click', exportToWord);
    }
    
    // Export to PDF function
    function exportToPDF() {
        // Create a window to print
        const printWindow = window.open('', '_blank');
        
        // Create content for PDF
        let content = `
            <html>
            <head>
                <title>Survey Results</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; }
                    h1 { color: #333; }
                    h2 { color: #555; margin-top: 20px; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                </style>
            </head>
            <body>
                <h1>Perfume Vending Machine Survey Results</h1>
        `;
        
        // Add each question's data
        Object.keys(surveyData).forEach(question => {
            // Skip suggestions and metadata fields
            if (question === 'suggestions' || question === 'formCount' || question.endsWith('_text') || question.endsWith('_type')) return;
            
            const questionLabel = getQuestionLabel(question);
            content += `<h2>${questionLabel}</h2>`;
            content += `<table><tr><th>Option</th><th>Count</th></tr>`;
            
            const options = surveyData[question];
            Object.keys(options).forEach(option => {
                const count = options[option];
                content += `<tr><td>${option}</td><td>${count}</td></tr>`;
            });
            
            content += `</table>`;
        });
        
        // Add suggestions
        if (surveyData.suggestions && surveyData.suggestions.length > 0) {
            content += `<h2>Suggestions & Feedback</h2><ul>`;
            surveyData.suggestions.forEach(suggestion => {
                const text = typeof suggestion === 'string' ? suggestion : (suggestion && suggestion.text ? suggestion.text : '');
                if (text) content += `<li>${text}</li>`;
            });
            content += `</ul>`;
        }
        
        content += `</body></html>`;
        
        // Write content to the new window
        printWindow.document.open();
        printWindow.document.write(content);
        printWindow.document.close();
        
        // Print after content is loaded
        setTimeout(() => {
            printWindow.print();
        }, 500);
    }
    
    // Export to CSV function
    function exportToCSV() {
        let csvContent = "data:text/csv;charset=utf-8,";
        
        // Add headers
        csvContent += "Question,Option,Count\r\n";
        
        // Add data rows
        Object.keys(surveyData).forEach(question => {
            // Skip suggestions and metadata fields
            if (question === 'suggestions' || question === 'formCount' || question.endsWith('_text') || question.endsWith('_type')) return;
            
            const questionLabel = getQuestionLabel(question);
            const options = surveyData[question];
            
            Object.keys(options).forEach(option => {
                const count = options[option];
                csvContent += `"${questionLabel}","${option}",${count}\r\n`;
            });
        });
        
        // Add suggestions section
        if (surveyData.suggestions && surveyData.suggestions.length > 0) {
            csvContent += "\r\nSuggestions:\r\n";
            surveyData.suggestions.forEach(suggestion => {
                const text = typeof suggestion === 'string' ? suggestion : (suggestion && suggestion.text ? suggestion.text : '');
                if (text) csvContent += `"${text}"\r\n`;
            });
        }
        
        // Create download link
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "survey_results.csv");
        document.body.appendChild(link);
        
        // Trigger download and remove link
        link.click();
        document.body.removeChild(link);
    }
    
    // Export to Excel function
    function exportToExcel() {
        // Create workbook
        let csvContent = "data:application/vnd.ms-excel;charset=utf-8,";
        
        // Add Excel XML header
        csvContent += '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>';
        csvContent += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
        csvContent += 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">';
        csvContent += '<Worksheet ss:Name="Survey Results">';
        csvContent += '<Table>';
        
        // Add headers
        csvContent += '<Row>';
        csvContent += '<Cell><Data ss:Type="String">Question</Data></Cell>';
        csvContent += '<Cell><Data ss:Type="String">Option</Data></Cell>';
        csvContent += '<Cell><Data ss:Type="String">Count</Data></Cell>';
        csvContent += '</Row>';
        
        // Add data rows
        Object.keys(surveyData).forEach(question => {
            // Skip suggestions and metadata fields
            if (question === 'suggestions' || question === 'formCount' || question.endsWith('_text') || question.endsWith('_type')) return;
            
            const questionLabel = getQuestionLabel(question);
            const options = surveyData[question];
            
            Object.keys(options).forEach(option => {
                const count = options[option];
                csvContent += '<Row>';
                csvContent += `<Cell><Data ss:Type="String">${questionLabel}</Data></Cell>`;
                csvContent += `<Cell><Data ss:Type="String">${option}</Data></Cell>`;
                csvContent += `<Cell><Data ss:Type="Number">${count}</Data></Cell>`;
                csvContent += '</Row>';
            });
        });
        
        // Add suggestions in a new worksheet if they exist
        if (surveyData.suggestions && surveyData.suggestions.length > 0) {
            csvContent += '</Table></Worksheet>';
            csvContent += '<Worksheet ss:Name="Suggestions">';
            csvContent += '<Table>';
            csvContent += '<Row><Cell><Data ss:Type="String">Suggestions</Data></Cell></Row>';
            
            surveyData.suggestions.forEach(suggestion => {
                const text = typeof suggestion === 'string' ? suggestion : (suggestion && suggestion.text ? suggestion.text : '');
                if (text) {
                    csvContent += '<Row>';
                    csvContent += `<Cell><Data ss:Type="String">${text}</Data></Cell>`;
                    csvContent += '</Row>';
                }
            });
        }
        
        // Close XML tags
        csvContent += '</Table></Worksheet></Workbook>';
        
        // Create download link
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "survey_results.xls");
        document.body.appendChild(link);
        
        // Trigger download and remove link
        link.click();
        document.body.removeChild(link);
    }

    // Export to Word function
    function exportToWord() {
        // Create Word document content using HTML format
        let wordContent = `
            <html xmlns:o='urn:schemas-microsoft-com:office:office' 
                  xmlns:w='urn:schemas-microsoft-com:office:word' 
                  xmlns='http://www.w3.org/TR/REC-html40'>
            <head>
                <meta charset='utf-8'>
                <title>Survey Results</title>
                <!--[if gte mso 9]>
                <xml>
                    <w:WordDocument>
                        <w:View>Print</w:View>
                        <w:Zoom>90</w:Zoom>
                        <w:DoNotPromptForConvert/>
                        <w:DoNotShowInsertionsAndDeletions/>
                    </w:WordDocument>
                </xml>
                <![endif]-->
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; }
                    h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
                    h2 { color: #555; margin-top: 30px; }
                    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                    th { background-color: #f8f9fa; font-weight: bold; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                    .suggestion-item { margin: 10px 0; padding: 10px; background-color: #f8f9fa; border-left: 4px solid #007bff; }
                </style>
            </head>
            <body>
                <h1>Survey Results Report</h1>
                <p><strong>Generated on:</strong> ${new Date().toLocaleDateString()}</p>
                
                <h2>Survey Analytics</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Question</th>
                            <th>Option</th>
                            <th>Count</th>
                            <th>Percentage</th>
                        </tr>
                    </thead>
                    <tbody>`;

        // Calculate total responses for percentage calculation
        let totalResponses = 0;
        Object.keys(surveyData).forEach(question => {
            if (question === 'suggestions' || question === 'formCount' || question.endsWith('_text') || question.endsWith('_type')) return;
            const options = surveyData[question];
            Object.values(options).forEach(count => totalResponses += count);
        });

        // Add data rows
        Object.keys(surveyData).forEach(question => {
            // Skip suggestions and metadata fields
            if (question === 'suggestions' || question === 'formCount' || question.endsWith('_text') || question.endsWith('_type')) return;
            
            const questionLabel = getQuestionLabel(question);
            const options = surveyData[question];
            
            Object.keys(options).forEach(option => {
                const count = options[option];
                const percentage = totalResponses > 0 ? ((count / totalResponses) * 100).toFixed(1) : '0.0';
                wordContent += `
                        <tr>
                            <td>${questionLabel}</td>
                            <td>${option}</td>
                            <td>${count}</td>
                            <td>${percentage}%</td>
                        </tr>`;
            });
        });

        wordContent += `
                    </tbody>
                </table>`;

        // Add suggestions section if they exist
        if (surveyData.suggestions && surveyData.suggestions.length > 0) {
            wordContent += `
                <h2>Suggestions & Feedback</h2>
                <div>`;
            
            surveyData.suggestions.forEach((suggestion, index) => {
                const text = typeof suggestion === 'string' ? suggestion : (suggestion && suggestion.text ? suggestion.text : '');
                if (text) {
                    wordContent += `
                    <div class="suggestion-item">
                        <strong>Suggestion ${index + 1}:</strong> ${text}
                    </div>`;
                }
            });
            
            wordContent += `</div>`;
        }

        wordContent += `
                <br><br>
                <p><em>This report was generated automatically from the survey data.</em></p>
            </body>
            </html>`;

        // Create blob and download
        const blob = new Blob([wordContent], {
            type: 'application/msword'
        });
        
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'survey_results.doc';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
    }

    // Initialize in-memory survey data; values hydrated from Supabase
    let surveyData = {
        age: { '10-20': 0, '20-40': 0, '40-60': 0, '60+': 0 },
        location: { 'Brands': 0, 'Malls': 0, 'Online': 0, 'Supermarkets': 0, 'Other': 0 },
        frequency: { 'Daily': 0, 'Few times a week': 0, 'Occasionally': 0, 'Rarely': 0, 'Never': 0 },
        reason: { 'Personal hygiene': 0, 'Social occasions': 0, 'Professional settings': 0, 'Self-confidence': 0, 'Other': 0 },
        problems: { 'Too expensive': 0, 'Not portable': 0, 'Runs out quickly': 0, 'No problems': 0, 'Other': 0 },
        would_use: { 'Definitely': 0, 'Probably': 0, 'Not sure': 0, 'Probably not': 0, 'Definitely not': 0 },
        installation: { 'Malls': 0, 'Gyms': 0, 'Public restrooms': 0, 'Office buildings': 0, 'Other': 0 },
        test_public: { 'Yes': 0, 'No': 0, 'Maybe': 0 },
        suggestions: [],
        formCount: 0
    };
    
    // Function to update form count display from Supabase
    async function updateFormCountDisplay() {
        const formCountElement = document.getElementById('form-count');
        if (!formCountElement) return;
        if (supabaseClient) {
            try {
                const { count } = await supabaseClient
                    .from('form_stats')
                    .select('*', { count: 'exact', head: true });
                formCountElement.textContent = `Forms filled: ${count || 0}`;
                return;
            } catch (e) {
                console.warn('Form count fetch failed', e.message);
            }
        }
        // Fallback to in-memory value
        formCountElement.textContent = `Forms filled: ${surveyData.formCount || 0}`;
    }
    
    // Initialize question bank from localStorage or with empty array
    let questionBank = JSON.parse(localStorage.getItem('questionBank')) || [];
    
    // Initialize version history from localStorage or with empty array
    let versionHistory = JSON.parse(localStorage.getItem('versionHistory')) || [];
    
    // Helper function to get question label/text
    function getQuestionLabel(questionId) {
        // Check if there's a custom text for this question
        if (surveyData[questionId + '_text']) {
            return surveyData[questionId + '_text'];
        }
        
        // Default question texts
        const questionLabels = {
            'age': 'What is your age group?',
            'location': 'Where do you usually buy perfumes?',
            'frequency': 'How often do you use perfumes?',
            'reason': 'Why do you use perfumes?',
            'problems': 'What problems have you faced with perfumes outside?',
            'would_use': 'Would you use a ₹5 per spray perfume vending machine?',
            'installation': 'Where would you prefer to see these vending machines installed?',
            'test_public': 'Would you test using a public perfume vending machine?'
        };
        
        return questionLabels[questionId] || questionId;
    }
    
    // Show survey form initially
    surveyContainer.classList.add('active');
    
    // Add delete buttons to existing questions
    addDeleteButtonsToExistingQuestions();
    
    // Load custom questions from localStorage
    function loadCustomQuestions() {
        Object.keys(surveyData).forEach(key => {
            if (key.startsWith('custom_') && !key.endsWith('_text') && !key.endsWith('_type')) {
                const options = Object.keys(surveyData[key]);
                const questionText = surveyData[key + '_text'] || key.replace('custom_', 'Custom Question ');
                const questionType = surveyData[key + '_type'] || 'radio';
                addQuestionToSurvey(key, questionText, options, questionType);
                addQuestionToResults(key, questionText);
            }
        });
    }
    
    // Initialize Supabase and hydrate data
    (async () => {
        await initSupabaseClient();
        await ensureBaseQuestions();
        await hydrateFromSupabase();
        await setupRealtime();
    })();
    
    // Update form count display on page load
    updateFormCountDisplay();
    
    // Handle form submission
    surveyForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        // Get form data
        const formData = new FormData(surveyForm);
        const entries = Array.from(formData.entries());
        // Insert suggestion if provided
        const suggestionEntry = entries.find(([k]) => k === 'suggestions');
        if (suggestionEntry && suggestionEntry[1].trim() !== '' && supabaseClient) {
            await supabaseClient.from('suggestions').insert({ text: suggestionEntry[1], status: 'none' });
        }
        // Insert answers: route text answers to suggestions; radio to survey_responses
        if (supabaseClient) {
            for (let [key, value] of entries) {
                if (key === 'suggestions') continue;
                const q = await getQuestionByCode(key);
                if (!q || !q.id) continue;
                const ans = (value || '').toString();
                if ((q.type || 'radio') === 'text') {
                    // Do not graph written answers; send to suggestions with question association
                    await supabaseClient.from('suggestions').insert({ text: ans, status: 'none', question_id: q.id, question_code: q.code });
                } else {
                    await supabaseClient.from('survey_responses').insert({ question_id: q.id, answer: ans });
                }
            }
            // Increment form count in form_stats
            await supabaseClient.from('form_stats').insert({});
            // Re-hydrate counts from Supabase so charts reflect latest submissions
            await hydrateFromSupabase();
        }

        // Update form count display
        updateFormCountDisplay();
        
        // Auto-save version after submission
        autoSaveVersion();
        
        // Reset form
        surveyForm.reset();
        
        // Show results: default to age (graph) unless active selection
        showResults('age');
        surveyContainer.classList.remove('active');
        resultsContainer.classList.add('active');
    });
    
    // Handle back to survey button
    backToSurveyBtn.addEventListener('click', function() {
        resultsContainer.classList.remove('active');
        surveyContainer.classList.add('active');
        // Ensure the header count stays fresh when navigating back
        updateFormCountDisplay();
    });
    
    // Handle view graph button
    viewGraphBtn.addEventListener('click', async function() {
        surveyContainer.classList.remove('active');
        resultsContainer.classList.add('active');
        // Refresh counts from backend before showing graphs
        await hydrateFromSupabase();
        showResults('age'); // Default to showing age results
    });
    
    // Handle add question button - open modal
    addQuestionBtn.addEventListener('click', function() {
        addQuestionModal.style.display = 'block';
    });
    
    // Question Bank functionality
    document.getElementById('open-question-bank-btn').addEventListener('click', function() {
        loadQuestionBank();
        document.getElementById('question-bank-modal').style.display = 'block';
    });
    
    // Version History functionality
    document.getElementById('version-history-btn').addEventListener('click', function() {
        loadVersionHistory();
        document.getElementById('version-history-modal').style.display = 'block';
    });
    
    // Close modals when clicking the X (close the parent modal of the X)
    closeModalBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const modal = btn.closest('.modal');
            if (modal) modal.style.display = 'none';
            if (deletePassword) deletePassword.value = '';
        });
    });
    
    // Question Bank Functions
    function loadQuestionBank() {
        const bankList = document.getElementById('question-bank-list');
        bankList.innerHTML = '';
        
        if (questionBank.length === 0) {
            bankList.innerHTML = '<p>No questions saved in the bank yet.</p>';
            return;
        }
        
        questionBank.forEach((item, index) => {
            const bankItem = document.createElement('div');
            bankItem.className = 'bank-item';
            
            const title = document.createElement('h3');
            title.textContent = item.text;
            
            const options = document.createElement('div');
            options.className = 'bank-item-options';
            options.innerHTML = '<strong>Options:</strong> ' + item.options.join(', ');
            
            const actions = document.createElement('div');
            actions.className = 'bank-item-actions';
            
            const useBtn = document.createElement('button');
            useBtn.textContent = 'Use Question';
            useBtn.addEventListener('click', () => useQuestionFromBank(index));
            
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'danger-btn';
            deleteBtn.addEventListener('click', () => deleteQuestionFromBank(index));
            
            actions.appendChild(useBtn);
            actions.appendChild(deleteBtn);
            
            bankItem.appendChild(title);
            bankItem.appendChild(options);
            bankItem.appendChild(actions);
            
            bankList.appendChild(bankItem);
        });
    }
    
    // Save current question to bank
    document.getElementById('save-to-bank-btn').addEventListener('click', function() {
        const currentQuestionSelect = document.getElementById('question-select');
        if (!currentQuestionSelect.value) {
            alert('Please select a question to save to the bank.');
            return;
        }
        
        const questionId = currentQuestionSelect.value;
        const questionText = getQuestionLabel(questionId);
        const options = Object.keys(surveyData[questionId]).filter(key => key !== '_text');
        
        // Check if question already exists in bank
        const exists = questionBank.some(item => item.text === questionText);
        if (exists) {
            alert('This question is already in the bank.');
            return;
        }
        
        // Add to question bank
        questionBank.push({
            text: questionText,
            options: options
        });
        
        // Save to localStorage
        localStorage.setItem('questionBank', JSON.stringify(questionBank));
        
        // Refresh the bank display
        loadQuestionBank();
        
        alert('Question saved to bank successfully!');
    });
    
    // Use question from bank
    function useQuestionFromBank(index) {
        const item = questionBank[index];
        document.getElementById('question-text').value = item.text;
        const type = item.type || 'radio';
        const typeSelect = document.getElementById('question-type');
        const optContainer = document.getElementById('options-container');
        const optionsGrp = document.getElementById('options-group');
        const textGrp = document.getElementById('text-answer-group');
        if (typeSelect) typeSelect.value = type;
        if (type === 'radio') {
            if (optionsGrp) optionsGrp.style.display = '';
            if (textGrp) textGrp.style.display = 'none';
            if (optContainer) {
                optContainer.innerHTML = '';
                const list = item.options && item.options.length ? item.options : ['',''];
                list.forEach(val => {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'option-input';
                    input.placeholder = 'Option';
                    input.value = val;
                    optContainer.appendChild(input);
                });
            }
        } else {
            if (optionsGrp) optionsGrp.style.display = 'none';
            if (textGrp) textGrp.style.display = '';
        }
        
        // Close bank modal and open add question modal
        document.getElementById('question-bank-modal').style.display = 'none';
        document.getElementById('add-question-modal').style.display = 'block';
    }
    
    // Delete question from bank
    function deleteQuestionFromBank(index) {
        if (confirm('Are you sure you want to delete this question from the bank?')) {
            questionBank.splice(index, 1);
            localStorage.setItem('questionBank', JSON.stringify(questionBank));
            loadQuestionBank();
        }
    }
    
    // Search functionality for question bank
    document.getElementById('bank-search').addEventListener('input', function() {
        const searchTerm = this.value.toLowerCase();
        const items = document.querySelectorAll('.bank-item');
        
        items.forEach(item => {
            const text = item.querySelector('h3').textContent.toLowerCase();
            const options = item.querySelector('.bank-item-options').textContent.toLowerCase();
            
            if (text.includes(searchTerm) || options.includes(searchTerm)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    });
    
    // Version Control Functions
    async function saveVersion() {
        // Create a new version snapshot
        const timestamp = new Date().toISOString();
        const versionName = `Version ${versionHistory.length + 1} - ${new Date().toLocaleString()}`;
        
        const versionSnapshot = {
            id: timestamp,
            name: versionName,
            data: JSON.parse(JSON.stringify(surveyData)), // Deep copy
            timestamp: timestamp
        };
        
        // Add to version history
        versionHistory.push(versionSnapshot);
        
        // Save to Supabase (and localStorage fallback)
        if (supabaseClient) {
            try { await supabaseClient.from('version_history').insert({ name: versionSnapshot.name, data: versionSnapshot.data }); }
            catch (e) { console.warn('version_history insert failed', e.message); }
        }
        localStorage.setItem('versionHistory', JSON.stringify(versionHistory));
        
        return versionSnapshot;
    }
    
    async function loadVersionHistory() {
        const versionList = document.getElementById('version-list');
        versionList.innerHTML = '';
        // Load from Supabase
        if (supabaseClient) {
            try {
                const { data } = await supabaseClient.from('version_history').select('*').order('created_at', { ascending: false });
                if (Array.isArray(data) && data.length) {
                    versionHistory = data.map(v => ({ id: v.id, name: v.name, data: v.data, timestamp: v.created_at }));
                }
            } catch (e) { console.warn('load version_history failed', e.message); }
        }
        // Bootstrap initial version if list is empty
        if (versionHistory.length === 0) {
            await saveVersion();
            versionList.innerHTML = '<p>Initial version created.</p>';
            return;
        }
        
        versionHistory.forEach((version, index) => {
            const versionItem = document.createElement('div');
            versionItem.className = 'version-item';
            
            const header = document.createElement('h3');
            header.innerHTML = `<span>${version.name}</span>`;
            
            const timestamp = document.createElement('div');
            timestamp.className = 'version-timestamp';
            timestamp.textContent = new Date(version.timestamp).toLocaleString();
            
            const actions = document.createElement('div');
            actions.className = 'version-item-actions';
            
            const restoreBtn = document.createElement('button');
            restoreBtn.textContent = 'Restore';
            restoreBtn.addEventListener('click', () => restoreVersion(index));
            
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'danger-btn';
            deleteBtn.addEventListener('click', () => deleteVersion(index));
            
            actions.appendChild(restoreBtn);
            if (index !== versionHistory.length - 1) {
                actions.appendChild(deleteBtn);
            }
            
            versionItem.appendChild(header);
            versionItem.appendChild(timestamp);
            versionItem.appendChild(actions);
            
            versionList.appendChild(versionItem);
        });
    }
    
    function restoreVersion(index) {
        if (confirm('Are you sure you want to restore this version? Current unsaved changes will be lost.')) {
            // Save current state as a new version before restoring
            saveVersion();
            
            // Restore the selected version
            surveyData = JSON.parse(JSON.stringify(versionHistory[index].data));
            localStorage.setItem('surveyData', JSON.stringify(surveyData));
            
            // Reload the page to reflect changes
            alert('Version restored successfully. The page will reload to apply changes.');
            window.location.reload();
        }
    }
    
    async function deleteVersion(index) {
        if (confirm('Are you sure you want to delete this version? This action cannot be undone.')) {
            const v = versionHistory[index];
            // Attempt server-side delete via admin; otherwise just remove locally
            const password = prompt('Enter admin password to delete this version:');
            if (password) {
                try {
                    const res = await fetch('/admin/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entity_type: 'version_history', id: v.id, admin_password: password })
                    });
                    const out = await res.json();
                    if (!out.success) alert('Delete failed: ' + (out.error || 'Unknown error'));
                } catch (e) { alert('Delete error: ' + e.message); }
            }
            versionHistory.splice(index, 1);
            localStorage.setItem('versionHistory', JSON.stringify(versionHistory));
            await loadVersionHistory();
        }
    }
    
    // Auto-save version when significant changes are made
    async function autoSaveVersion() {
        // Only save if there are already versions (initial setup is complete)
        if (versionHistory.length > 0) {
            await saveVersion();
        }
    }
    
    // Close modals when clicking outside of them
    window.addEventListener('click', function(event) {
        if (event.target === addQuestionModal) {
            addQuestionModal.style.display = 'none';
        }
        if (event.target === deleteConfirmModal) {
            deleteConfirmModal.style.display = 'none';
            // Reset password field
            deletePassword.value = '';
        }
    });
    
    // Handle cancel delete button
    cancelDeleteBtn.addEventListener('click', function() {
        deleteConfirmModal.style.display = 'none';
        deletePassword.value = '';
    });
    
    // Handle confirm delete button (server-side admin)
    confirmDeleteBtn.addEventListener('click', async function() {
        const password = deletePassword.value;
        if (!password) { alert('Enter admin password.'); return; }
        if (!questionToDelete) return;
        try {
            const q = await getQuestionByCode(questionToDelete);
            if (!q || !q.id) { alert('Question not found in backend.'); return; }
            const res = await fetch('/admin/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_type: 'survey_questions', id: q.id, admin_password: password })
            });
            const out = await res.json();
            if (out.success) {
                const questionElement = document.getElementById(`question-${questionToDelete}`);
                if (questionElement) questionElement.remove();
                const resultButton = document.querySelector(`[data-question="${questionToDelete}"]`);
                if (resultButton) resultButton.remove();
                deleteConfirmModal.style.display = 'none';
                deletePassword.value = '';
                const firstAvailableButton = document.querySelector('.result-btn');
                if (firstAvailableButton) {
                    showResults(firstAvailableButton.dataset.question || firstAvailableButton.getAttribute('data-question'));
                }
                questionToDelete = null;
            } else {
                alert('Delete failed: ' + (out.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Delete error: ' + e.message);
        }
    });
    
    // Add Question modal dynamic options UI
    const questionTypeSelect = document.getElementById('question-type');
    const optionsGroup = document.getElementById('options-group');
    const optionsContainer = document.getElementById('options-container');
    const textAnswerGroup = document.getElementById('text-answer-group');

    function addOptionInput(initialValue = '') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'option-input';
        input.placeholder = 'Option';
        input.value = initialValue;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addOptionInput('');
                const inputs = optionsContainer.querySelectorAll('.option-input');
                inputs[inputs.length - 1].focus();
            }
        });
        optionsContainer.appendChild(input);
    }

    function ensureMinimumOptions() {
        const current = optionsContainer ? optionsContainer.querySelectorAll('.option-input').length : 0;
        for (let i = current; i < 2; i++) addOptionInput('');
    }

    function resetOptionsUI() {
        if (optionsContainer) optionsContainer.innerHTML = '';
        ensureMinimumOptions();
    }

    function collectOptionsFromInputs() {
        return Array.from(optionsContainer.querySelectorAll('.option-input'))
            .map(i => i.value.trim())
            .filter(v => v !== '');
    }

    function setTypeUI(type) {
        if (!optionsGroup || !textAnswerGroup) return;
        if (type === 'radio') {
            optionsGroup.style.display = '';
            textAnswerGroup.style.display = 'none';
            resetOptionsUI();
        } else {
            optionsGroup.style.display = 'none';
            textAnswerGroup.style.display = '';
        }
    }

    if (questionTypeSelect) {
        setTypeUI(questionTypeSelect.value);
        questionTypeSelect.addEventListener('change', () => setTypeUI(questionTypeSelect.value));
    }

    // Handle add question form submission
    addQuestionForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        // Get form values
        const questionText = document.getElementById('question-text').value;
        const questionType = document.getElementById('question-type').value;
        // options from dynamic inputs
        const addToBank = document.getElementById('add-to-bank').checked;
        const destination = document.querySelector('input[name="question-destination"]:checked').value;
        
        // For Write Option type, we don't need multiple options
        let options = [];
        if (questionType === 'radio') {
            options = collectOptionsFromInputs();
            if (options.length < 2) {
                alert('Please provide at least 2 options for multiple choice questions.');
                return;
            }
        }
        
        // Create a unique ID for the new question
        const questionId = 'custom_' + Date.now();
        
        // Handle destination choice
        if (destination === 'form') {
            // Add to survey data structure with question text as metadata
            surveyData[questionId] = {};
            // Initialize options with zero counts
            if (questionType === 'radio') {
                options.forEach(option => {
                    surveyData[questionId][option] = 0;
                });
            }
            // Store question text and type as metadata
            surveyData[questionId + '_text'] = questionText;
            surveyData[questionId + '_type'] = questionType;

            // Persist to Supabase survey_questions so it survives refresh
            if (supabaseClient) {
                try {
                    const { data: inserted, error } = await supabaseClient
                        .from('survey_questions')
                        .insert({ code: questionId, text: questionText, type: questionType, options: options, in_bank: !!addToBank })
                        .select('*')
                        .single();
                    if (!error && inserted) {
                        idToCode.set(inserted.id, questionId);
                        questionCache.set(questionId, inserted);
                    }
                } catch (e) { console.warn('Insert survey_question failed', e.message); }
            } else {
                // Fallback to localStorage if Supabase not configured
                localStorage.setItem('surveyData', JSON.stringify(surveyData));
            }
            
            // Add the question to the survey form
            addQuestionToSurvey(questionId, questionText, options, questionType);
            
            // Add the question to results navigation
            addQuestionToResults(questionId, questionText);
        }
        
        // Add the question to the question bank if checked or if destination is bank only
        if (addToBank || destination === 'bank') {
            if (supabaseClient) {
                try {
                    await supabaseClient.from('question_bank').insert({ question_text: questionText, type: questionType, options: options });
                } catch (e) { console.warn('Insert question_bank failed', e.message); }
            } else {
                if (!questionBank) questionBank = [];
                questionBank.push({ id: questionId, text: questionText, type: questionType, options: options });
                localStorage.setItem('questionBank', JSON.stringify(questionBank));
            }
        }
        
        // Show appropriate success message
        if (destination === 'form') {
            alert('Question added to survey form successfully!');
        } else {
            alert('Question saved to question bank successfully!');
        }
        
        // Close the modal and reset form
        addQuestionModal.style.display = 'none';
        addQuestionForm.reset();
        setTypeUI(questionTypeSelect.value);
    });
    
    // Handle result navigation buttons
    resultButtons.forEach(button => {
        button.addEventListener('click', function() {
            const question = this.getAttribute('data-question');
            
            // Update active button
            resultButtons.forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');
            
            // Show results for selected question
            showResults(question);
        });
    });
    
    // Function to display suggestions (Supabase-backed)
    async function displaySuggestions() {
        const suggestionsContainer = document.getElementById('suggestions-list');
        suggestionsContainer.innerHTML = '';
        
        // Refresh from Supabase
        if (supabaseClient) {
            const { data: suggs } = await supabaseClient.from('suggestions').select('*').order('created_at', { ascending: false });
            surveyData.suggestions = (suggs || []).map(s => ({ id: s.id, text: s.text, flagged: s.status === 'red', flagReason: '', status: s.status || 'none' }));
        }
        
        if (surveyData.suggestions.length === 0) {
            suggestionsContainer.innerHTML = '<p class="no-suggestions">No suggestions submitted yet.</p>';
            return;
        }
        
        surveyData.suggestions.forEach(suggestion => {
            // Handle both string suggestions (legacy) and object suggestions (new format)
            if (typeof suggestion === 'string') {
                // Convert to new format
                suggestion = {
                    id: Date.now() + Math.random().toString(36).substr(2, 9),
                    text: suggestion,
                    flagged: false,
                    flagReason: ''
                };
            }
            
            const suggestionItem = document.createElement('div');
            suggestionItem.className = 'suggestion-item';
            if (suggestion.flagged) {
                suggestionItem.classList.add('flagged');
            }
            
            const suggestionText = document.createElement('p');
            suggestionText.textContent = suggestion.text || suggestion;
            
            const suggestionActions = document.createElement('div');
            suggestionActions.className = 'suggestion-actions';
            
            // Create markers container
            const markersContainer = document.createElement('div');
            markersContainer.className = 'feedback-markers';
            
            // Red marker (left)
            const redMarker = document.createElement('span');
            redMarker.className = 'marker red-marker';
            redMarker.title = 'Flag as inappropriate';
            redMarker.addEventListener('click', async function() {
                // Toggle red marker without password
                if (redMarker.classList.contains('active')) {
                    redMarker.classList.remove('active');
                    suggestionItem.classList.remove('flagged');
                    
                    // Update suggestion object
                    suggestion.flagged = false;
                    suggestion.flagReason = '';
                    
                    // Remove flag reason if exists
                    const existingReason = suggestionItem.querySelector('.flag-reason');
                    if (existingReason) {
                        existingReason.remove();
                    }
                    // Update Supabase status -> none
                    if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'none' }).eq('id', suggestion.id);
                } else {
                    // Deactivate green marker if active
                    greenMarker.classList.remove('active');
                    
                    // Activate red marker
                    redMarker.classList.add('active');
                    suggestionItem.classList.add('flagged');
                    
                    // Ask for reason
                    const reason = prompt('Enter reason for flagging this response:');
                    if (reason) {
                        suggestion.flagged = true;
                        suggestion.flagReason = reason;
                        
                        // Remove existing reason if any
                        const existingReason = suggestionItem.querySelector('.flag-reason');
                        if (existingReason) {
                            existingReason.remove();
                        }
                        
                        // Add flag reason
                        const flagReason = document.createElement('div');
                        flagReason.className = 'flag-reason';
                        flagReason.textContent = `Flagged: ${reason}`;
                        suggestionItem.appendChild(flagReason);
                        // Update Supabase status -> red
                        if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'red' }).eq('id', suggestion.id);
                    }
                }
                autoSaveVersion();
            });
            
            // Green marker (right)
            const greenMarker = document.createElement('span');
            greenMarker.className = 'marker green-marker';
            greenMarker.title = 'Mark as approved';
            greenMarker.addEventListener('click', async function() {
                // Toggle green marker without password
                if (greenMarker.classList.contains('active')) {
                    greenMarker.classList.remove('active');
                } else {
                    // Deactivate red marker if active
                    redMarker.classList.remove('active');
                    suggestionItem.classList.remove('flagged');
                    
                    // Remove flag reason if exists
                    const existingReason = suggestionItem.querySelector('.flag-reason');
                    if (existingReason) {
                        existingReason.remove();
                    }
                    
                    // Update suggestion object
                    suggestion.flagged = false;
                    suggestion.flagReason = '';
                    
                    // Activate green marker
                    greenMarker.classList.add('active');
                    // Update Supabase status -> green
                    if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'green' }).eq('id', suggestion.id);
                }
                autoSaveVersion();
            });
            
            markersContainer.appendChild(redMarker);
            markersContainer.appendChild(greenMarker);
            
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'danger-btn';
            deleteBtn.addEventListener('click', async function() {
                const password = prompt('Enter admin password to delete this feedback:');
                if (!password) return;
                try {
                    const res = await fetch('/admin/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entity_type: 'suggestions', id: suggestion.id, admin_password: password })
                    });
                    const out = await res.json();
                    if (out.success) {
                        suggestionItem.remove();
                        autoSaveVersion();
                    } else {
                        alert('Delete failed: ' + (out.error || 'Unknown error'));
                    }
                } catch (e) {
                    alert('Delete error: ' + e.message);
                }
            });
            
            suggestionActions.appendChild(markersContainer);
            suggestionActions.appendChild(deleteBtn);
            
            suggestionItem.appendChild(suggestionText);
            suggestionItem.appendChild(suggestionActions);
            
            // Add flag reason if flagged
            if (suggestion.flagged && suggestion.flagReason) {
                const flagReason = document.createElement('div');
                flagReason.className = 'flag-reason';
                flagReason.textContent = `Flagged: ${suggestion.flagReason}`;
                suggestionItem.appendChild(flagReason);
                
                // Activate red marker
                redMarker.classList.add('active');
            }
            
            suggestionsContainer.appendChild(suggestionItem);
        });
    }

    // Display feedback specific to a question (text-type), with markers and delete
    async function displayQuestionFeedback(questionCode) {
        const titleEl = document.getElementById('question-feedback-title');
        const listEl = document.getElementById('question-feedback-list');
        const containerEl = document.getElementById('question-feedback-container');
        if (!titleEl || !listEl || !containerEl) return;

        // Set title based on question label
        titleEl.textContent = `Feedback: ${getQuestionLabel(questionCode)}`;
        listEl.innerHTML = '';

        // Fetch feedback from suggestions for this question
        let items = [];
        if (supabaseClient) {
            const { data: suggs } = await supabaseClient
                .from('suggestions')
                .select('*')
                .eq('question_code', questionCode)
                .order('created_at', { ascending: false });
            items = (suggs || []).map(s => ({ id: s.id, text: s.text, status: s.status || 'none' }));
        }

        if (items.length === 0) {
            listEl.innerHTML = '<p class="no-suggestions">No feedback submitted for this question yet.</p>';
            return;
        }

        items.forEach(item => {
            const suggestionItem = document.createElement('div');
            suggestionItem.className = 'suggestion-item';
            if (item.status === 'red') suggestionItem.classList.add('flagged');

            const suggestionText = document.createElement('p');
            suggestionText.textContent = item.text;

            const suggestionActions = document.createElement('div');
            suggestionActions.className = 'suggestion-actions';

            const markersContainer = document.createElement('div');
            markersContainer.className = 'feedback-markers';

        const redMarker = document.createElement('span');
        redMarker.className = 'marker red-marker';
        redMarker.title = 'Flag as inappropriate';
        if (item.status === 'red') redMarker.classList.add('active');
        redMarker.addEventListener('click', async function() {
            // Toggle red marker with reason prompt similar to main suggestions
            if (redMarker.classList.contains('active')) {
                redMarker.classList.remove('active');
                suggestionItem.classList.remove('flagged');
                const existingReason = suggestionItem.querySelector('.flag-reason');
                if (existingReason) existingReason.remove();
                if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'none' }).eq('id', item.id);
            } else {
                // Deactivate green marker if active
                greenMarker.classList.remove('active');
                redMarker.classList.add('active');
                suggestionItem.classList.add('flagged');
                const reason = prompt('Enter reason for flagging this response:');
                if (reason) {
                    const existingReason = suggestionItem.querySelector('.flag-reason');
                    if (existingReason) existingReason.remove();
                    const flagReason = document.createElement('div');
                    flagReason.className = 'flag-reason';
                    flagReason.textContent = `Flagged: ${reason}`;
                    suggestionItem.appendChild(flagReason);
                }
                if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'red' }).eq('id', item.id);
            }
            autoSaveVersion();
        });

            const greenMarker = document.createElement('span');
            greenMarker.className = 'marker green-marker';
            greenMarker.title = 'Mark as approved';
            if (item.status === 'green') greenMarker.classList.add('active');
            greenMarker.addEventListener('click', async function() {
                const isActive = greenMarker.classList.contains('active');
                if (isActive) {
                    greenMarker.classList.remove('active');
                    if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'none' }).eq('id', item.id);
                } else {
                    redMarker.classList.remove('active');
                    suggestionItem.classList.remove('flagged');
                    greenMarker.classList.add('active');
                    if (supabaseClient) await supabaseClient.from('suggestions').update({ status: 'green' }).eq('id', item.id);
                }
                autoSaveVersion();
            });

            markersContainer.appendChild(redMarker);
            markersContainer.appendChild(greenMarker);

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'danger-btn';
            deleteBtn.addEventListener('click', async function() {
                const password = prompt('Enter admin password to delete this feedback:');
                if (!password) return;
                try {
                    const res = await fetch('/admin/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entity_type: 'suggestions', id: item.id, admin_password: password })
                    });
                    const out = await res.json();
                    if (out.success) {
                        suggestionItem.remove();
                        autoSaveVersion();
                    } else {
                        alert('Delete failed: ' + (out.error || 'Unknown error'));
                    }
                } catch (e) {
                    alert('Delete error: ' + e.message);
                }
            });

            suggestionActions.appendChild(markersContainer);
            suggestionActions.appendChild(deleteBtn);

            suggestionItem.appendChild(suggestionText);
            suggestionItem.appendChild(suggestionActions);

            listEl.appendChild(suggestionItem);
        });
    }
    
    // Function to add a new question to the survey form
    function addQuestionToSurvey(questionId, questionText, options, questionType) {
        // Get the last question in the form
        const lastQuestion = document.querySelector('#survey-form .question:last-of-type');
        
        // Create new question element
        const newQuestion = document.createElement('div');
        newQuestion.className = 'question';
        newQuestion.id = `question-${questionId}`;
        
        // Get the number of existing questions for numbering
        const questionNumber = document.querySelectorAll('#survey-form .question').length + 1;
        
        // Create question header with title and delete button
        const questionHeader = document.createElement('div');
        questionHeader.className = 'question-header';
        
        // Create question title
        const questionTitle = document.createElement('h3');
        questionTitle.textContent = `${questionNumber}. ${questionText}`;
        // Store original title for reliable renumbering
        questionTitle.setAttribute('data-title', questionText);
        questionHeader.appendChild(questionTitle);
        
        // Create delete button
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-question-btn';
        deleteButton.innerHTML = '&times;';
        deleteButton.title = 'Delete Question';
        deleteButton.setAttribute('data-question-id', questionId);
        deleteButton.addEventListener('click', function() {
            const password = prompt("Enter admin password to delete this question:");
            if (password === ADMIN_PASSWORD) {
                // Remove question element from the form
                const elem = document.getElementById(`question-${questionId}`);
                if (elem) elem.remove();
                
                // Remove question data and metadata
                if (surveyData[questionId]) delete surveyData[questionId];
                delete surveyData[questionId + '_text'];
                delete surveyData[questionId + '_type'];
                localStorage.setItem('surveyData', JSON.stringify(surveyData));
                
                // Remove results nav button if exists
                const navBtn = document.querySelector(`.results-nav [data-question="${questionId}"]`);
                if (navBtn) navBtn.remove();

                // Renumber remaining questions after deletion
                renumberQuestions();
            } else {
                alert("Incorrect password. Action cancelled.");
            }
        });
        
        questionHeader.appendChild(deleteButton);
        
        // Create options container
        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'options';
        
        // Add options based on question type
        if (questionType === 'radio') {
            // For multiple choice questions
            options.forEach(option => {
                const label = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = questionId;
                input.value = option;
                
                label.appendChild(input);
                label.appendChild(document.createTextNode(` ${option}`));
                optionsContainer.appendChild(label);
            });
        } else if (questionType === 'text') {
            // For write option questions
            const textArea = document.createElement('textarea');
            textArea.name = questionId;
            textArea.rows = 3;
            textArea.placeholder = 'Write your answer here...';
            optionsContainer.appendChild(textArea);
        }
        
        // Assemble the question
        newQuestion.appendChild(questionHeader);
        newQuestion.appendChild(optionsContainer);
        
        // Insert the new question before the last element (suggestions and submit button)
        lastQuestion.parentNode.insertBefore(newQuestion, lastQuestion);

        // Renumber all questions to keep sequence consistent
        renumberQuestions();
    }

    // Ensure question numbers are sequential across the form
    function renumberQuestions() {
        const questions = document.querySelectorAll('#survey-form .question');
        let index = 1;
        questions.forEach(q => {
            const titleEl = q.querySelector('.question-header h3');
            if (!titleEl) return;
            const original = titleEl.getAttribute('data-title') || titleEl.textContent.replace(/^\s*\d+\.\s+/, '');
            titleEl.textContent = `${index}. ${original}`;
            index++;
        });
    }
    
    // Function to add a new question to the results navigation
    function addQuestionToResults(questionId, questionText) {
        // Get the results navigation
        const resultsNav = document.querySelector('.results-nav');
        
        // Create a new button for the question
        const newButton = document.createElement('button');
        newButton.className = 'result-btn';
        newButton.setAttribute('data-question', questionId);
        
        // Use a shorter version of the question text for the button
        const shortText = questionText.length > 15 ? questionText.substring(0, 15) + '...' : questionText;
        newButton.textContent = shortText;
        
        // Add event listener to the new button
        newButton.addEventListener('click', function() {
            // Update active button
            document.querySelectorAll('.result-btn').forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');
            
            // Show results for this question
            showResults(questionId);
        });
        
        // Add the button to the navigation
        resultsNav.appendChild(newButton);
    }
    
    // Function to display results for a question
    async function showResults(question) {
        const data = surveyData[question];
        const isMobile = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;
        
        // Also refresh general suggestions
        await displaySuggestions();

        // Switch to feedback mode if question is text-type
        const qType = surveyData[question + '_type'] || (questionCache.get(question)?.type) || 'radio';
        const chartContainerEl = document.querySelector('.chart-container');
        const feedbackContainerEl = document.getElementById('question-feedback-container');
        if (qType === 'text') {
            if (chartContainerEl) chartContainerEl.style.display = 'none';
            if (feedbackContainerEl) feedbackContainerEl.style.display = '';
            await displayQuestionFeedback(question);
            return;
        } else {
            if (chartContainerEl) chartContainerEl.style.display = '';
            if (feedbackContainerEl) feedbackContainerEl.style.display = 'none';
        }
        
        // Get all possible options for this question from the form
        const allOptions = [];
        const questionElement = document.querySelector(`[name="${question}"]`);
        if (questionElement) {
            // Find all radio buttons with the same name
            const radioButtons = document.querySelectorAll(`input[name="${question}"]`);
            radioButtons.forEach(radio => {
                // Extract clean option value (just the option word)
                const optionValue = radio.value;
                if (optionValue && !allOptions.includes(optionValue)) {
                    allOptions.push(optionValue);
                }
            });
        }
        
        // Clean data and ensure all options are included (even with zero responses)
        const cleanData = {};
        
        // First add all possible options with zero count
        allOptions.forEach(option => {
            cleanData[option] = 0;
        });
        
        // Then update with actual response counts
        Object.entries(data).forEach(([key, value]) => {
            if (key && key.trim() !== '' && typeof value === 'number') {
                // Clean the key to remove any extra text or symbols
                const cleanKey = key.trim();
                cleanData[cleanKey] = value;
            }
        });
        
        const labels = Object.keys(cleanData);
        const values = Object.values(cleanData);
        
        // Calculate total responses for Y-axis scaling
        const totalResponses = values.reduce((sum, value) => sum + value, 0);
        const maxValue = Math.max(...values, 1); // Ensure at least 1 for empty data
        
        // Determine Y-axis tick step based on total responses
        // This implements the dynamic Y-axis tick adjustment logic
        let stepSize;
        if (totalResponses <= 10) {
            stepSize = 1; // 1, 2, 3, 4, 5...
        } else if (totalResponses <= 30) {
            stepSize = 2; // 2, 4, 6, 8...
        } else if (totalResponses <= 100) {
            stepSize = 5; // 5, 10, 15, 20...
        } else {
            stepSize = 10; // 10, 20, 30...
        }
        
        // Destroy previous chart if exists
        if (window.resultsChartInstance) {
            window.resultsChartInstance.destroy();
        }
        
        // Create new chart with dynamic Y-axis configuration
        window.resultsChartInstance = new Chart(resultsChart, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: getQuestionLabel(question),
                    data: values,
                    backgroundColor: [
                        'rgba(255, 99, 132, 0.7)',
                        'rgba(54, 162, 235, 0.7)',
                        'rgba(255, 206, 86, 0.7)',
                        'rgba(75, 192, 192, 0.7)',
                        'rgba(153, 102, 255, 0.7)',
                        'rgba(255, 159, 64, 0.7)'
                    ],
                    borderColor: [
                        'rgba(255, 99, 132, 1)',
                        'rgba(54, 162, 235, 1)',
                        'rgba(255, 206, 86, 1)',
                        'rgba(75, 192, 192, 1)',
                        'rgba(153, 102, 255, 1)',
                        'rgba(255, 159, 64, 1)'
                    ],
                    borderWidth: 1,
                    barPercentage: 0.6,
                    categoryPercentage: 0.7
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: `Survey Results: ${getQuestionLabel(question)}`,
                        padding: { top: isMobile ? 6 : 10, bottom: isMobile ? 14 : 10 },
                        font: {
                            size: 16
                        }
                    },
                    tooltip: {
                        callbacks: {
                            footer: function(tooltipItems) {
                                return `Total responses: ${totalResponses}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Survey Options',
                            font: {
                                size: 14
                            }
                        },
                        ticks: {
                            autoSkip: false,
                            maxRotation: 45,
                            minRotation: 45
                        }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Number of Responses',
                            font: {
                                size: 14
                            }
                        },
                        ticks: {
                            precision: 0,
                            stepSize: stepSize,
                            // Add comment about Y-axis scaling to the chart
                            callback: function(value, index, values) {
                                return value;
                            }
                        }
                    }
                }
            }
        });
        
        // Add comment about Y-axis scaling logic
        const chartContainer = document.querySelector('.chart-container');
        let scaleComment = document.getElementById('scale-comment');
        
        if (!scaleComment) {
            scaleComment = document.createElement('div');
            scaleComment.id = 'scale-comment';
            scaleComment.style.fontSize = '12px';
            scaleComment.style.color = '#666';
            scaleComment.style.marginTop = '10px';
            scaleComment.style.textAlign = 'center';
            chartContainer.appendChild(scaleComment);
        }
        
        scaleComment.innerHTML = `<strong>Y-axis Scale:</strong> ${
            totalResponses <= 10 ? 'Using unit intervals (1, 2, 3...)' :
            totalResponses <= 30 ? 'Using intervals of 2 (2, 4, 6...)' :
            totalResponses <= 100 ? 'Using intervals of 5 (5, 10, 15...)' :
            'Using intervals of 10 (10, 20, 30...)'
        } based on ${totalResponses} total responses.`;
    }
    
    // Helper function to get question label/text (unified)
    function getQuestionLabel(questionId) {
        // Prefer custom text if available (for dynamically added questions)
        if (surveyData[questionId + '_text']) {
            return surveyData[questionId + '_text'];
        }

        // Default full question texts
        const questionLabels = {
            'age': 'What is your age group?',
            'location': 'Where do you usually buy perfumes?',
            'frequency': 'How often do you use perfumes?',
            'reason': 'Why do you use perfumes?',
            'problems': 'What problems have you faced with perfumes outside?',
            'would_use': 'Would you use a ₹5 per spray perfume vending machine?',
            'installation': 'Where would you prefer to see these vending machines installed?',
            'test_public': 'Would you test using a public perfume vending machine?'
        };

        return questionLabels[questionId] || questionId;
    }
    
    // Pull to refresh functionality
    let touchStartY = 0;
    let touchEndY = 0;
    
    document.addEventListener('touchstart', function(e) {
        touchStartY = e.touches[0].clientY;
    }, false);
    
    document.addEventListener('touchmove', function(e) {
        touchEndY = e.touches[0].clientY;
    }, false);
    
    document.addEventListener('touchend', function(e) {
        const pullDistance = touchEndY - touchStartY;
        
        // If pulled down more than 100px and at the top of the page
        if (pullDistance > 100 && window.scrollY === 0) {
            // Show pull indicator
            const pullIndicator = document.createElement('div');
            pullIndicator.className = 'pull-indicator visible';
            pullIndicator.textContent = 'Refreshing...';
            document.body.prepend(pullIndicator);
            
            // Simulate refresh after 1 second
            setTimeout(function() {
                location.reload();
            }, 1000);
        }
    }, false);
});