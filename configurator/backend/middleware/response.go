package middleware

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jitsucom/jitsu/configurator/openapi"
	"github.com/jitsucom/jitsu/server/middleware"
)

// ErrorResponse returns openapi error response wrapper
func ErrorResponse(message string, err error) *openapi.ErrorObject {
	eo := &openapi.ErrorObject{
		Message: message,
	}

	if err != nil {
		errMsg := err.Error()
		eo.Error = &errMsg
	}

	return eo
}

var OkResponse = openapi.StatusResponse{Status: middleware.StatusOK}

func StatusOk(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, OkResponse)
}

func Error(ctx *gin.Context, statusCode int, message string, err error) {
	ctx.AbortWithStatusJSON(statusCode, ErrorResponse(message, err))
}

func InternalError(ctx *gin.Context, message string, err error) {
	Error(ctx, http.StatusInternalServerError, message, err)
}

func Unauthorized(ctx *gin.Context, err error) {
	Error(ctx, http.StatusUnauthorized, "authorization failed", err)
}

func Forbidden(ctx *gin.Context, msg string) {
	Error(ctx, http.StatusForbidden, msg, nil)
}

func ForbiddenProject(ctx *gin.Context, projectID string) {
	Forbidden(ctx, fmt.Sprintf("User does not have access to the project: %s", projectID))
}

func BadRequest(ctx *gin.Context, msg string, err error) {
	Error(ctx, http.StatusBadRequest, msg, err)
}

func InvalidInputJSON(ctx *gin.Context, err error) {
	BadRequest(ctx, "invalid input JSON", err)
}

func RequiredField(ctx *gin.Context, field string) {
	BadRequest(ctx, fmt.Sprintf("%s is required", field), nil)
}
