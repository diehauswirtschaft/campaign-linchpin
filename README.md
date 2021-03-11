<img width="460" alt="die HausWirtschaft Logo" src="https://tools.diehauswirtschaft.at/public-static-files/logos/dhw-signet-logotype.png">

# campaign-postman

A simple [Cloud Functions](https://cloud.google.com/functions?hl=en) based service to receive applications via an
Elementor form used in the [HausWirtschaft call](https://diehauswirtschaft.at/call/).

<hr>

This project has been developed in the scope of [OPENhauswirtschaft][1]
for die HausWirtschaft.
OPENhauswirtschaft is powered by the Austrian ["Klima- und Energiefonds"][2]'s
*[Smart Cities Demo - Living Urban Innovation][3]* program.

<img width="200" alt="" src="https://tools.diehauswirtschaft.at/public-static-files/logos/klien-poweredby.jpg">

## Deployment

The Node.js 14 runtime is required. All environment variables must be set in `.env.yaml` at deployment time.
Take a look in the public example for all required key-value pairs. The Cloud Functions runtime will install
all dependencies via `npm ci` during the deployment process.

### Required files

Before any deployment to Google Cloud, the following files must be present in the project directory:

* `/.env.yaml` for all environment variables
* `/confirmation-mail.html` for the rich-text confirmation e-mail
* `/confirmation-mail.txt` a plain text version of the confirmation as fallback

## License

Apache 2.0

[1]: https://www.smartcities.at/stadt-projekte/smart-cities/#innovatives-hauswirtschaften-im-nutzungsgemischten-stadtkern
[2]: https://www.klimafonds.gv.at/
[3]: https://www.smartcities.at/
