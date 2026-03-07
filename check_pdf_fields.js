const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

async function checkFields() {
    try {
        const filePath = path.resolve(__dirname, '../frontend/public/Report.pdf');
        if (!fs.existsSync(filePath)) {
            console.error('File not found:', filePath);
            return;
        }
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const form = pdfDoc.getForm();
        const fields = form.getFields();

        if (fields.length === 0) {
            console.log('No form fields found in the PDF.');
        } else {
            console.log('Form fields found:');
            fields.forEach(field => {
                const type = field.constructor.name;
                const name = field.getName();
                console.log(`- ${name} (${type})`);
            });
        }
    } catch (error) {
        console.error('Error reading PDF:', error);
    }
}

checkFields();
