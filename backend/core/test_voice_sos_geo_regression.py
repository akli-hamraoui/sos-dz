from unittest.mock import patch

from core.tests import BaseAPITestCase, NEED_PAYLOAD, make_campaign
from core.models import Need


class VoiceSOSGeoRegressionTests(BaseAPITestCase):
    """Regression coverage for the dedicated /needs/voice-guide/ location gate.

    In particular, a valid GPS fix must not be rejected merely because the
    server cannot resolve the request IP with GeoLite2.
    """

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()

    def _payload(self, **overrides):
        data = dict(NEED_PAYLOAD, campaign=self.campaign.pk)
        data.update(overrides)
        return data

    def test_gps_inside_algeria_allows_voice_sos_when_ip_is_unknown(self):
        with patch("core.views.is_algeria_ip", return_value=None):
            resp = self.client.post(
                "/api/needs/voice-guide/",
                self._payload(latitude="36.75", longitude="3.06"),
                format="json",
            )

        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Need.objects.count(), 1)

    def test_gps_outside_algeria_is_rejected_even_if_ip_is_algerian(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            resp = self.client.post(
                "/api/needs/voice-guide/",
                self._payload(latitude="48.85", longitude="2.35"),
                format="json",
            )

        self.assertEqual(resp.status_code, 403, resp.content)
        self.assertEqual(Need.objects.count(), 0)

    def test_no_gps_uses_authoritative_server_ip_fallback(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            resp = self.client.post(
                "/api/needs/voice-guide/",
                self._payload(),
                format="json",
            )

        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Need.objects.count(), 1)

    def test_no_gps_is_rejected_when_server_ip_is_unknown(self):
        with patch("core.views.is_algeria_ip", return_value=None):
            resp = self.client.post(
                "/api/needs/voice-guide/",
                self._payload(),
                format="json",
            )

        self.assertEqual(resp.status_code, 403, resp.content)
        self.assertEqual(Need.objects.count(), 0)

    def test_client_bigdatacloud_country_is_not_authorization_proof(self):
        with patch("core.views.is_algeria_ip", return_value=None):
            resp = self.client.post(
                "/api/needs/voice-guide/",
                self._payload(location_country_code="DZ"),
                format="json",
            )

        self.assertEqual(resp.status_code, 403, resp.content)
        self.assertEqual(Need.objects.count(), 0)
