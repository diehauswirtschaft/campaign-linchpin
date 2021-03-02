const fs = require("fs");

const Joi = require("joi");
const axios = require("axios");
const FormData = require("form-data");
const PDFDocument = require("pdfkit");

const {Storage} = require("@google-cloud/storage");
const storage = new Storage();

const {
    GCP_STORAGE_BUCKET,
    MT_TOKEN,
    MT_SECTION_ID,
    MT_LABEL_INTERESSENTIN,
    MT_LABEL_FUNNEL_WEBSITE,
    MT_LABEL_PAKET_1,
    MT_LABEL_PAKET_2,
    MT_LABEL_PAKET_3,
    MT_LABEL_PAKET_4,
    MT_LABEL_PAKET_DEFAULT,
} = process.env;

const TEXT_FONT_SIZE = 11;
const LABELS = {
    interessentin: parseInt(MT_LABEL_INTERESSENTIN),
    funnelWebsite: parseInt(MT_LABEL_FUNNEL_WEBSITE),
    paket1: parseInt(MT_LABEL_PAKET_1),
    paket2: parseInt(MT_LABEL_PAKET_2),
    paket3: parseInt(MT_LABEL_PAKET_3),
    paket4: parseInt(MT_LABEL_PAKET_4),
    paketDefault: parseInt(MT_LABEL_PAKET_DEFAULT),
};

const fieldSchema = Joi.object({
    id: Joi.string(),
    type: Joi.string(),
    title: Joi.string(),
    value: Joi.string().allow(""),
    raw_value: Joi.string().allow(""),
    required: Joi.string().allow(""),
});

const shortFieldSchema = Joi.object({
    id: Joi.string(),
    type: Joi.string(),
    title: Joi.string(),
    value: Joi.string().allow("").max(100),
    raw_value: Joi.string().allow("").max(100),
    required: Joi.string().allow(""),
});

function escapeValue(str) {
    return str.replace(/\n/g, " ").replace(/ +/g, " ").trim();
}

function escapeMtmd(str) {
    return str.replace(/([#*_~>`\[\]()]|\n(\d+\.|-) )|---+/g, " ");
}

/**
 * Stores the request body into a Cloud Storage bucket.
 */
async function storeRequest(requestId, bodyObj) {
    // Save each submission into a bucket.
    const bucket = storage.bucket(GCP_STORAGE_BUCKET);
    const file = bucket.file(`${requestId}.json`);
    try {
        await file.save(JSON.stringify(bodyObj, null, 2));
    } catch(e) {
        console.error(e);
    }
}

/**
 * Creates a new task in MeisterTask and attaches a PDF to it.
 */
async function createTask(requestId, form) {
    const pdfPath = `/tmp/${requestId}.pdf`;
    const doc = new PDFDocument({
        size: "A4",
        margins: {
            top: 72,
            left: 72,
            bottom: 72,
            right: 72,
        }
    });
    doc.pipe(fs.createWriteStream(pdfPath));
    try {
        doc
            .font("Helvetica-Bold", 18)
            .text(`Call-Bewerbung\n${escapeValue(form.fields.name.value)}`, {align: 'center'})
            .moveDown();

        // Inline-like fields.
        [
            { label: "Name", value: form.fields.name.value },
            { label: "E-Mail", value: form.fields.email.value },
            { label: "Telefon", value: form.fields.telefon.value },
            { label: "Paket", value: form.fields.paket.value },
            { label: "Schon Interessent*in", value: form.fields.interessentin.value },
        ].forEach(line => {
            doc
                .font("Helvetica-Bold", TEXT_FONT_SIZE)
                .text(`${line.label}:  `, { continued: true })
                .font("Helvetica", TEXT_FONT_SIZE)
                .text(escapeValue(line.value));
        });
        doc.moveDown();

        // Block-like fields.
        [
            { label: "Wie möchtest Du die Gewerbefläche nutzen?", value: form.fields.gewerbe_nutzung.value },
            { label: "Was gefällt Dir an dem Gedanken, Teil der Genossenschaft die HausWirtschaft zu werden?", value: form.fields.gedanken_community.value },
            { label: "Wie möchtest Du dich in die Gemeinschaft einbringen?", value: form.fields.einbringen.value },
            { label: "Sonstige Fragen und Infos?", value: form.fields.sonstiges.value },
        ].forEach(line => {
            doc
                .font("Helvetica-Bold", TEXT_FONT_SIZE)
                .text(line.label)
                .font("Helvetica", TEXT_FONT_SIZE)
                .text(escapeValue(line.value) || "-")
                .moveDown();
        });

        doc
            .moveDown()
            .font("Helvetica", 8)
            .text("Generiert um " + new Date().toLocaleString("de-AT", { timeZone: "Europe/Vienna" }));
    } finally {
        doc.end();
    }

    const labels = [LABELS.funnelWebsite];
    const notes = [];

    // Fields used in the Meistertask tasks.
    const name = escapeValue(escapeMtmd(form.fields.name.value));
    const email = escapeValue(escapeMtmd(form.fields.email.value));
    const phone = escapeValue(escapeMtmd(form.fields.telefon.value));
    const alreadyOnList = /ja/i.test(form.fields.interessentin.value);

    if (email.length >= 6 && email.length <= 100) {
        notes.push(`E-Mail: ${email}`);
    } else {
        notes.push(`E-Mail: -`);
    }

    if (phone.length >= 8 && phone.length <= 20) {
        notes.push(`Telefon: ${phone}`);
    } else {
        notes.push(`Telefon: -`);
    }

    if (alreadyOnList) {
        notes.push("Ist bereits Interessent*In");
        labels.push(LABELS.interessentin);
    }

    // Assigns a specific label for each available package.
    const paketId = form.fields.paket.value.match(/Paket ([1-4])/i);
    if (paketId !== null) {
        switch (paketId[1]) {
            case "1": labels.push(LABELS.paket1); break;
            case "2": labels.push(LABELS.paket2); break;
            case "3": labels.push(LABELS.paket3); break;
            case "4": labels.push(LABELS.paket4); break;
        }
    } else {
        labels.push(LABELS.paketDefault);
    }

    try {
        const task = await axios.post(
            `https://www.meistertask.com/api/sections/${MT_SECTION_ID}/tasks`,
            {
                "section_id": MT_SECTION_ID,
                "name": name,
                "notes": `${notes.join("\n")}`,
                "label_ids": labels,
            },
            {
                headers: {
                    "Authorization": `Bearer ${MT_TOKEN}`,
                },
            }
        );

        try {
            const fd = new FormData();
            fd.append("name", `call-${requestId}.pdf`);
            fd.append("local", fs.createReadStream(pdfPath));

            const config = Object.assign({
                method: "POST",
                url: `https://www.meistertask.com/api/tasks/${task.data.id}/attachments`,
                data: fd,
                headers: Object.assign({}, fd.getHeaders(), { "Authorization": `Bearer ${MT_TOKEN}` }),
            });
            await axios.request(config);
            await fs.promises.unlink(pdfPath);

            return task.data.id;
        } catch (e) {
            console.error(`Could not upload PDF for task ${task.data.id}`);
        }
    } catch (e) {
        console.error(`Could not add to Meistertask: ${e}`);
    }

    return null;
}

exports.saveForm = async (req, res) => {
    if (req.method === "POST") {
        res.setHeader("Cache-Control", "no-cache");

        if (req.get("content-type") !== "application/x-www-form-urlencoded" || typeof req.body !== "object") {
            return res.status(400).send("Invalid form submission!");
        }

        const requestId = `${Date.now()}-${Math.ceil(Math.random() * 10000)}`;
        storeRequest(requestId, req.body).then(() => { /* do nothing */ });

        const querySchema = Joi.object({
            form: Joi.object({
                id: Joi.string(),
                name: Joi.string(),
            }),
            fields: Joi.object({
                gewerbe_nutzung: fieldSchema,
                gedanken_community: fieldSchema,
                einbringen: fieldSchema,
                sonstiges: fieldSchema,
                name: shortFieldSchema,
                email: shortFieldSchema,
                telefon: shortFieldSchema,
                interessentin: shortFieldSchema,
                paket: shortFieldSchema,
            }),
            meta: Joi.object(),
        });

        const {error, value} = querySchema.validate(req.body);
        if (error) {
            console.warn(`Invalid parameters provided in request ${requestId}: ${JSON.stringify(error.details)}`);
            return res.status(400).send("Invalid parameters provided!");
        }

        // Asynchronously create a new task in MeisterTask.
        // Prevents long-blocking request responses which let Elementor's form fail.
        createTask(requestId, value).then((taskId) => {
            if (taskId !== null) {
                console.log(`Created task ${taskId} for request ${requestId}.`);
            } else {
                console.error(`Failed to create a task for request ${requestId}.`);
            }
        });

        return res.status(200).send("Submitted.");
    } else {
        res.set("Allow", "POST");
        return res.status(405).send("Method Not Allowed");
    }
};
