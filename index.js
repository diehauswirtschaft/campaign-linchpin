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

exports.saveForm = async (req, res) => {
    if (req.method === "POST") {
        res.setHeader("Cache-Control", "no-cache");

        if (req.get("content-type") !== "application/x-www-form-urlencoded" || typeof req.body !== "object") {
            return res.status(400).send("Invalid form submission!");
        }

        const requestID = `${Date.now()}-${Math.ceil(Math.random() * 10000)}`;

        // Save each submission into a bucket.
        const bucket = storage.bucket(GCP_STORAGE_BUCKET);
        const file = bucket.file(`${requestID}.json`);
        try {
            await file.save(JSON.stringify(req.body, null, 2));
        } catch(e) {
            console.error(e);
            return res.status(500).send("Could not process request.");
        }

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
            console.warn(`Invalid parameters provided in request ${requestID}: ${JSON.stringify(error.details)}`);
            return res.status(400).send("Invalid parameters provided!");
        }

        // create a document and pipe to a blob
        const pdfPath = `/tmp/${requestID}.pdf`;
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
                .text(`Call-Bewerbung\n${escapeValue(value.fields.name.value)}`, {align: 'center'})
                .moveDown();

            // Inline-like fields.
            [
                { label: "Name", value: value.fields.name.value },
                { label: "E-Mail", value: value.fields.email.value },
                { label: "Telefon", value: value.fields.telefon.value },
                { label: "Paket", value: value.fields.paket.value },
                { label: "Schon Interessent*in", value: value.fields.interessentin.value },
            ].forEach(line => {
                doc
                    .font("Helvetica-Bold", 12)
                    .text(`${line.label}:  `, { continued: true })
                    .font("Helvetica", 12)
                    .text(escapeValue(line.value));
            });
            doc.moveDown();

            // Block-like fields.
            [
                { label: "Wie möchtest Du die Gewerbefläche nutzen?", value: value.fields.gewerbe_nutzung.value },
                { label: "Was gefällt Dir an dem Gedanken, Teil der Genossenschaft die HausWirtschaft zu werden?", value: value.fields.gedanken_community.value },
                { label: "Wie möchtest Du dich in die Gemeinschaft einbringen?", value: value.fields.einbringen.value },
                { label: "Sonstige Fragen und Infos?", value: value.fields.sonstiges.value },
            ].forEach(line => {
                doc
                    .font("Helvetica-Bold", 12)
                    .text(line.label)
                    .font("Helvetica", 12)
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
        const name = escapeValue(escapeMtmd(value.fields.name.value));
        const email = escapeValue(escapeMtmd(value.fields.email.value));
        const phone = escapeValue(escapeMtmd(value.fields.telefon.value));
        const alreadyOnList = /ja/i.test(value.fields.interessentin.value);

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
        const paketId = value.fields.paket.value.match(/Paket ([1-4])/i);
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
                fd.append("name", `call-${requestID}.pdf`);
                fd.append("local", fs.createReadStream(pdfPath));

                const config = Object.assign({
                    method: "POST",
                    url: `https://www.meistertask.com/api/tasks/${task.data.id}/attachments`,
                    data: fd,
                    headers: Object.assign({}, fd.getHeaders(), { "Authorization": `Bearer ${MT_TOKEN}` }),
                });
                await axios.request(config);
                await fs.promises.unlink(pdfPath);

                return res.status(200).send("Submitted.");
            } catch (e) {
                console.error(`Could not upload PDF for task ${task.data.id}`);
                return res.status(500).send("Could not finish submission!");
            }
        } catch (e) {
            console.error(`Could not add to Meistertask: ${e}`);
            return res.status(500).send("Could not finish submission!");
        }
    } else {
        res.set("Allow", "POST");
        return res.status(405).send("Method Not Allowed");
    }
};
