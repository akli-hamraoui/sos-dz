from rest_framework.exceptions import Throttled
from rest_framework.views import exception_handler as drf_exception_handler


def rassemble_exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if isinstance(exc, Throttled) and response is not None:
        wait = exc.wait
        response.data = {
            "detail": (
                "Too many submissions from this connection. "
                f"Please wait about {int(wait // 60) + 1} minute(s) and try again."
                if wait
                else "Too many submissions from this connection. Please try again later."
            )
        }
    return response
