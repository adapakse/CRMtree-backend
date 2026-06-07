pipeline {
  agent any
  environment {
    ACR             = 'crmtreeregistry.azurecr.io'
    ACR_USER        = 'crmtreeregistry'
    RG              = 'rg-crmtree-prod'
    TAG             = "${env.BUILD_NUMBER}"
    DOCKER_BUILDKIT = '0'
  }
  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('Build') {
      steps {
        sh "docker build -t ${ACR}/crmtree-backend:${TAG} ."
      }
    }
    stage('Push to ACR') {
      steps {
        withCredentials([string(credentialsId: 'CRMTREE_ACR_PASSWORD', variable: 'ACR_PASS')]) {
          sh """
            docker login ${ACR} -u ${ACR_USER} -p ${ACR_PASS}
            docker push ${ACR}/crmtree-backend:${TAG}
          """
        }
      }
    }
    stage('Deploy to Azure') {
      steps {
        withCredentials([azureServicePrincipal('CRMTREE_AZURE_SP')]) {
          sh """
            az login --service-principal \
              -u $AZURE_CLIENT_ID -p $AZURE_CLIENT_SECRET --tenant $AZURE_TENANT_ID
            az containerapp update \
              --name crmtree-backend \
              --resource-group ${RG} \
              --image ${ACR}/crmtree-backend:${TAG}
          """
        }
      }
    }
  }
  post {
    success { echo "CRMtree backend deploy ${TAG} — sukces" }
    failure { echo "CRMtree backend deploy ${TAG} — błąd" }
  }
}